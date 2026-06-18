// =====================================================================
// Edge Function: automacao-regras  (cockpit - CRUD de regras duras)
//   -> GET / POST / PUT / DELETE /automacao-regras
//
// CRUD das regras duras (fora_de_ramo / termo_produto) persistidas em
// triagem_regras e consumidas DETERMINISTICAMENTE pela triagem (E5). Contrato
// 3.2.5 (RF-20, US-12).
//
//   GET    -> { regras: [{ id, tipo, termo, ativo, criado_em }] }
//   POST   -> cria regra { tipo, termo, ativo } -> { id, ok: true }
//   PUT    -> atualiza { id, termo, ativo } -> { id, ok: true } | 404
//   DELETE -> remove { id } -> { id, ok: true } | 404
//
// Termo duplicado (UNIQUE tipo+termo) -> 409. Body invalido -> 400.
// Autorizacao na borda (US-21): requireAuthorizedUser -> 401/403. Toda escrita
// auditada via logSensitiveAction. Escrita com service_role (tabelas de triagem
// fora das views lia.*, SEC-3).
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

const FUNCTION_SEGMENT = "automacao-regras";

/** Codigo PostgREST/Postgres de violacao de unicidade (UNIQUE tipo+termo). */
const PG_UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------
// Schemas (zod) por metodo de escrita.
// ---------------------------------------------------------------------

const tipoEnum = z.enum(["fora_de_ramo", "termo_produto"]);
const termoSchema = z.string().trim().min(1, "termo nao pode ser vazio").max(
  500,
  "termo muito longo",
);

const postBodySchema = z.object({
  tipo: tipoEnum,
  termo: termoSchema,
  ativo: z.boolean(),
});

const putBodySchema = z.object({
  id: z.string().uuid("id deve ser um uuid valido"),
  termo: termoSchema,
  ativo: z.boolean(),
});

const deleteBodySchema = z.object({
  id: z.string().uuid("id deve ser um uuid valido"),
});

/** true quando o erro do PostgREST e violacao de UNIQUE (tipo, termo). */
function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === PG_UNIQUE_VIOLATION;
}

// ---------------------------------------------------------------------
// GET: lista todas as regras.
// ---------------------------------------------------------------------

async function handleGet(db: ServiceClient): Promise<Response> {
  const { data, error } = await db
    .from("triagem_regras")
    .select("id, tipo, termo, ativo, criado_em")
    .order("criado_em", { ascending: false });
  if (error) {
    throw new Error(`falha ao listar regras: ${error.message}`);
  }
  return jsonResponse({ regras: data ?? [] }, 200);
}

// ---------------------------------------------------------------------
// POST: cria regra (409 em duplicado).
// ---------------------------------------------------------------------

async function handlePost(req: Request, db: ServiceClient, usuario: string): Promise<Response> {
  const body = await parseJsonBody(req, postBodySchema);

  const { data, error } = await db
    .from("triagem_regras")
    .insert({
      tipo: body.tipo,
      termo: body.termo,
      ativo: body.ativo,
      criado_por: usuario,
    })
    .select("id")
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "regra_duplicada", "ja existe uma regra com este tipo e termo");
    }
    throw new Error(`falha ao criar regra: ${error.message}`);
  }
  const id = (data as { id: string }).id;

  await logSensitiveAction({
    tabela: "triagem_regras",
    acao: "regra_criar",
    registroId: id,
    usuario,
    dadosNovos: { tipo: body.tipo, termo: body.termo, ativo: body.ativo },
  });

  return jsonResponse({ id, ok: true }, 200);
}

// ---------------------------------------------------------------------
// PUT: atualiza termo/ativo por id (404 inexistente, 409 duplicado).
// ---------------------------------------------------------------------

async function handlePut(req: Request, db: ServiceClient, usuario: string): Promise<Response> {
  const body = await parseJsonBody(req, putBodySchema);

  const { data, error } = await db
    .from("triagem_regras")
    .update({ termo: body.termo, ativo: body.ativo })
    .eq("id", body.id)
    .select("id")
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "regra_duplicada", "ja existe uma regra com este tipo e termo");
    }
    throw new Error(`falha ao atualizar regra: ${error.message}`);
  }
  if (!data) {
    throw new HttpError(404, "regra_nao_encontrada", "regra inexistente");
  }

  await logSensitiveAction({
    tabela: "triagem_regras",
    acao: "regra_atualizar",
    registroId: body.id,
    usuario,
    dadosNovos: { termo: body.termo, ativo: body.ativo },
  });

  return jsonResponse({ id: body.id, ok: true }, 200);
}

// ---------------------------------------------------------------------
// DELETE: remove por id (404 inexistente).
// ---------------------------------------------------------------------

async function handleDelete(req: Request, db: ServiceClient, usuario: string): Promise<Response> {
  const body = await parseJsonBody(req, deleteBodySchema);

  const { data, error } = await db
    .from("triagem_regras")
    .delete()
    .eq("id", body.id)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao remover regra: ${error.message}`);
  }
  if (!data) {
    throw new HttpError(404, "regra_nao_encontrada", "regra inexistente");
  }

  await logSensitiveAction({
    tabela: "triagem_regras",
    acao: "regra_remover",
    registroId: body.id,
    usuario,
  });

  return jsonResponse({ id: body.id, ok: true }, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "POST", "PUT", "DELETE"]);

    // Autorizacao na borda: 401 sem sessao, 403 fora da allowlist.
    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();

    switch (req.method) {
      case "GET":
        return await handleGet(db);
      case "POST":
        return await handlePost(req, db, ctx.email);
      case "PUT":
        return await handlePut(req, db, ctx.email);
      case "DELETE":
        return await handleDelete(req, db, ctx.email);
      default:
        // assertMethod ja barra; defensivo para o exhaustiveness do switch.
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido");
    }
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
