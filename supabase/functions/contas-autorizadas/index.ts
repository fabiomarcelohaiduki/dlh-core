// =====================================================================
// Edge Function: contas-autorizadas  ->  /contas-autorizadas
// CRUD da allowlist de acesso (tabela contas_autorizadas, US-21/RF-38).
//
// A allowlist e o portao unico de acesso do cockpit: is_conta_autorizada()
// (RLS) e o auth-google so deixam entrar quem consta aqui (por e-mail OU
// dominio, ativo=true). Esta funcao permite administrar a lista pelo proprio
// cockpit (tela Conta), sem SQL manual.
//
//   GET    -> lista todas as contas (id, tipo, valor, ativo, createdAt).
//   POST   -> cria { tipo:'email'|'dominio', valor }. Normaliza lowercase;
//             valor UNIQUE -> 409 conta_duplicada.
//   PATCH  -> { id, ativo } liga/desliga uma entrada.
//   DELETE -> ?id=<uuid> remove uma entrada.
//
// Toda escrita roda no escopo do usuario (RLS via ctx.db) e dispara o
// trigger de auditoria (audit_log carimba o e-mail autenticado).
//
// TRAVA ANTI-LOCKOUT: desativar/remover a UNICA entrada que autoriza o
// proprio solicitante e bloqueado (409 lockout_bloqueado) — evita que um
// admin se tranque para fora. Remover OUTRAS contas segue liberado.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  contaAutorizadaCreateSchema,
  contaAutorizadaToggleSchema,
  parseJsonBody,
} from "../_shared/validation.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

interface ContaRow {
  id: string;
  tipo: "email" | "dominio";
  valor: string;
  ativo: boolean;
  created_at: string | null;
}

/** Linha do banco -> contrato camelCase devolvido ao cockpit. */
function toConta(r: ContaRow) {
  return {
    id: r.id,
    tipo: r.tipo,
    valor: r.valor,
    ativo: r.ativo,
    createdAt: r.created_at,
  };
}

/**
 * Decide se `email` permaneceria autorizado considerando apenas as entradas
 * ATIVAS informadas (por e-mail exato OU dominio). Usado pela trava
 * anti-lockout: passamos a lista ativa JA SEM a entrada que sera removida/
 * desativada e verificamos se o solicitante ainda entra.
 */
function emailAindaAutorizado(ativos: ContaRow[], email: string): boolean {
  const norm = email.trim().toLowerCase();
  const dominio = norm.includes("@") ? norm.split("@")[1] ?? "" : "";
  return ativos.some((r) => {
    const valor = r.valor.toLowerCase();
    if (r.tipo === "email") return valor === norm;
    if (r.tipo === "dominio") return valor === dominio;
    return false;
  });
}

/**
 * Garante que remover/desativar a entrada `afetadaId` nao deixaria o
 * solicitante (`email`) sem acesso. Le as entradas ATIVAS exceto a afetada
 * e, se o solicitante deixar de casar, lanca 409.
 */
async function assertSemAutoLockout(
  db: SupabaseClient,
  email: string,
  afetadaId: string,
): Promise<void> {
  const { data, error } = await db
    .from("contas_autorizadas")
    .select("id, tipo, valor, ativo, created_at")
    .eq("ativo", true)
    .neq("id", afetadaId);
  if (error) {
    throw new HttpError(500, "allowlist_query_failed", "falha ao validar a allowlist");
  }
  if (!emailAindaAutorizado((data ?? []) as ContaRow[], email)) {
    throw new HttpError(
      409,
      "lockout_bloqueado",
      "Esta acao removeria o seu proprio acesso. Cadastre outra conta autorizada antes.",
    );
  }
}

async function handleGet(req: Request): Promise<Response> {
  const { db } = await requireAuthorizedUser(req);
  const { data, error } = await db
    .from("contas_autorizadas")
    .select("id, tipo, valor, ativo, created_at")
    .order("tipo", { ascending: true })
    .order("valor", { ascending: true });
  if (error) {
    throw new HttpError(500, "allowlist_query_failed", "falha ao listar contas autorizadas");
  }
  return jsonResponse({ contas: ((data ?? []) as ContaRow[]).map(toConta) }, 200);
}

async function handlePost(req: Request): Promise<Response> {
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, contaAutorizadaCreateSchema);
  const valor = input.valor.trim().toLowerCase();

  const { data, error } = await db
    .from("contas_autorizadas")
    .insert({ tipo: input.tipo, valor, ativo: true })
    .select("id, tipo, valor, ativo, created_at")
    .single();

  if (error) {
    // 23505 = unique_violation (valor UNIQUE): conta ja cadastrada.
    if (error.code === "23505") {
      throw new HttpError(409, "conta_duplicada", "Esta conta ou dominio ja esta na lista.");
    }
    throw new HttpError(500, "allowlist_insert_failed", "falha ao cadastrar a conta autorizada");
  }

  await logSensitiveAction({
    tabela: "contas_autorizadas",
    acao: "allowlist_criar",
    registroId: (data as ContaRow).id,
    usuario: email,
    dadosNovos: { tipo: input.tipo, valor },
  });

  return jsonResponse(toConta(data as ContaRow), 201);
}

async function handlePatch(req: Request): Promise<Response> {
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, contaAutorizadaToggleSchema);

  // Desativar a propria autorizacao unica = lockout. Bloqueia antes de aplicar.
  if (!input.ativo) {
    await assertSemAutoLockout(db, email, input.id);
  }

  const { data, error } = await db
    .from("contas_autorizadas")
    .update({ ativo: input.ativo })
    .eq("id", input.id)
    .select("id, tipo, valor, ativo, created_at")
    .single();

  if (error || !data) {
    throw new HttpError(404, "conta_nao_encontrada", "conta autorizada nao encontrada");
  }

  await logSensitiveAction({
    tabela: "contas_autorizadas",
    acao: input.ativo ? "allowlist_ativar" : "allowlist_desativar",
    registroId: input.id,
    usuario: email,
    dadosNovos: { ativo: input.ativo },
  });

  return jsonResponse(toConta(data as ContaRow), 200);
}

async function handleDelete(req: Request): Promise<Response> {
  const { db, email } = await requireAuthorizedUser(req);
  const id = new URL(req.url).searchParams.get("id")?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new HttpError(400, "id_invalido", "informe o id (uuid) da conta a remover");
  }

  // Remover a propria autorizacao unica = lockout. Bloqueia antes de aplicar.
  await assertSemAutoLockout(db, email, id);

  const { data, error } = await db
    .from("contas_autorizadas")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "allowlist_delete_failed", "falha ao remover a conta autorizada");
  }
  if (!data) {
    throw new HttpError(404, "conta_nao_encontrada", "conta autorizada nao encontrada");
  }

  await logSensitiveAction({
    tabela: "contas_autorizadas",
    acao: "allowlist_remover",
    registroId: id,
    usuario: email,
  });

  return jsonResponse({ ok: true, id }, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "POST", "PATCH", "DELETE"]);
    switch (req.method) {
      case "GET":
        return await handleGet(req);
      case "POST":
        return await handlePost(req);
      case "PATCH":
        return await handlePatch(req);
      default:
        return await handleDelete(req);
    }
  } catch (err) {
    return await errorResponse(err, { fn: "contas-autorizadas" });
  }
}

getEnv();

Deno.serve(handler);
