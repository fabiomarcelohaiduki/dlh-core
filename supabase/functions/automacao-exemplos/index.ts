// =====================================================================
// Edge Function: automacao-exemplos  (cockpit - curadoria do few-shot, E14)
//   -> GET / PATCH / DELETE /automacao-exemplos
//
// Administra o acervo de aprendizado few-shot (`triagem_exemplos`): lista os
// exemplos rotulados, DESATIVA/REATIVA (`ativo`, soft-delete reversivel) e
// REMOVE fisicamente um exemplo ruim. A FILA so seleciona `ativo = true`.
// Contrato 3.2.6.1 (RF-21, US-13).
//
//   GET    -> { itens: [{ id, texto, veredito_rotulado, ativo, aviso_id,
//                         decisao_id, criado_em }], next_cursor }
//             filtros: veredito (lixo|duvida|util|todos), ativo (bool opcional),
//             limite (default 50), cursor.
//   PATCH  -> { id, ativo } alterna ativo -> { id, ok: true } | 404
//   DELETE -> { id } remove fisicamente -> { id, ok: true } | 404
//
// O `texto` exposto e o trecho/objeto do exemplo; NUNCA conteudo_verbatim/
// payload_bruto. Autorizacao na borda (US-21): requireAuthorizedUser -> 401/403.
// PATCH/DELETE auditados via logSensitiveAction. Escrita com service_role
// (tabelas de triagem fora das views lia.*, SEC-3).
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "automacao-exemplos";

const DEFAULT_LIMITE = 50;
const MIN_LIMITE = 1;
const MAX_LIMITE = 200;

const VEREDITOS = new Set(["lixo", "duvida", "util", "todos"]);

// ---------------------------------------------------------------------
// Schemas (zod) de escrita.
// ---------------------------------------------------------------------

const patchBodySchema = z.object({
  id: z.string().uuid("id deve ser um uuid valido"),
  ativo: z.boolean(),
});

const deleteBodySchema = z.object({
  id: z.string().uuid("id deve ser um uuid valido"),
});

/** Item exposto na listagem (sem embedding, sem conteudo sensivel). */
interface ExemploItem {
  id: string;
  texto: string;
  veredito_rotulado: string | null;
  ativo: boolean;
  aviso_id: string | null;
  decisao_id: string | null;
  criado_em: string;
}

interface ExemploRow {
  id: string;
  texto: string | null;
  veredito_rotulado: string | null;
  ativo: boolean | null;
  aviso_id: string | null;
  decisao_id: string | null;
  criado_em: string;
}

/** Normaliza `limite`: default 50, faixa [1, 200] (cap, nao rejeita). */
function normalizeLimite(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMITE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < MIN_LIMITE) {
    return DEFAULT_LIMITE;
  }
  return Math.min(parsed, MAX_LIMITE);
}

/** Interpreta `ativo` da query: "true"/"false" -> boolean; ausente -> undefined. */
function parseAtivoParam(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

// ---------------------------------------------------------------------
// GET: lista o acervo (keyset por criado_em desc, id desc).
// ---------------------------------------------------------------------

async function handleGet(req: Request, db: ServiceClient): Promise<Response> {
  const url = new URL(req.url);
  const veredito = (url.searchParams.get("veredito") ?? "todos").toLowerCase();
  const vereditoFiltro = VEREDITOS.has(veredito) ? veredito : "todos";
  const ativoFiltro = parseAtivoParam(url.searchParams.get("ativo"));
  const limite = normalizeLimite(url.searchParams.get("limite"));
  const cursor = url.searchParams.get("cursor");

  let query = db
    .from("triagem_exemplos")
    .select("id, texto, veredito_rotulado, ativo, aviso_id, decisao_id, criado_em");

  if (vereditoFiltro !== "todos") {
    query = query.eq("veredito_rotulado", vereditoFiltro);
  }
  if (ativoFiltro !== undefined) {
    query = query.eq("ativo", ativoFiltro);
  }

  // Keyset por cursor (uuid): retoma apos o exemplo apontado, na ordem
  // (criado_em desc, id desc). Cursor desconhecido => recomeca do inicio.
  if (cursor) {
    const { data: cursorRow } = await db
      .from("triagem_exemplos")
      .select("criado_em")
      .eq("id", cursor)
      .maybeSingle();
    const cursorEm = cursorRow?.criado_em as string | undefined;
    if (cursorEm) {
      query = query.or(
        `criado_em.lt."${cursorEm}",` +
          `and(criado_em.eq."${cursorEm}",id.lt."${cursor}")`,
      );
    }
  }

  const { data, error } = await query
    .order("criado_em", { ascending: false })
    .order("id", { ascending: false })
    .limit(limite);
  if (error) {
    throw new Error(`falha ao listar exemplos: ${error.message}`);
  }

  const rows = (data ?? []) as ExemploRow[];
  const itens: ExemploItem[] = rows.map((row) => ({
    id: row.id,
    texto: row.texto ?? "",
    veredito_rotulado: row.veredito_rotulado ?? null,
    ativo: row.ativo === true,
    aviso_id: row.aviso_id ?? null,
    decisao_id: row.decisao_id ?? null,
    criado_em: row.criado_em,
  }));

  const nextCursor = itens.length === limite ? itens[itens.length - 1].id : null;

  return jsonResponse({ itens, next_cursor: nextCursor }, 200);
}

// ---------------------------------------------------------------------
// PATCH: alterna ativo (soft-delete reversivel). 404 se id inexistente.
// ---------------------------------------------------------------------

async function handlePatch(req: Request, db: ServiceClient, usuario: string): Promise<Response> {
  const body = await parseJsonBody(req, patchBodySchema);

  const { data, error } = await db
    .from("triagem_exemplos")
    .update({ ativo: body.ativo })
    .eq("id", body.id)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao atualizar exemplo: ${error.message}`);
  }
  if (!data) {
    throw new HttpError(404, "exemplo_nao_encontrado", "exemplo inexistente");
  }

  await logSensitiveAction({
    tabela: "triagem_exemplos",
    acao: "exemplo_alternar_ativo",
    registroId: body.id,
    usuario,
    dadosNovos: { ativo: body.ativo },
  });

  return jsonResponse({ id: body.id, ok: true }, 200);
}

// ---------------------------------------------------------------------
// DELETE: exclusao fisica. 404 se id inexistente.
// ---------------------------------------------------------------------

async function handleDelete(req: Request, db: ServiceClient, usuario: string): Promise<Response> {
  const body = await parseJsonBody(req, deleteBodySchema);

  const { data, error } = await db
    .from("triagem_exemplos")
    .delete()
    .eq("id", body.id)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao remover exemplo: ${error.message}`);
  }
  if (!data) {
    throw new HttpError(404, "exemplo_nao_encontrado", "exemplo inexistente");
  }

  await logSensitiveAction({
    tabela: "triagem_exemplos",
    acao: "exemplo_remover",
    registroId: body.id,
    usuario,
  });

  return jsonResponse({ id: body.id, ok: true }, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "PATCH", "DELETE"]);

    // Autorizacao na borda: 401 sem sessao, 403 fora da allowlist.
    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();

    switch (req.method) {
      case "GET":
        return await handleGet(req, db);
      case "PATCH":
        return await handlePatch(req, db, ctx.email);
      case "DELETE":
        return await handleDelete(req, db, ctx.email);
      default:
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido");
    }
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
