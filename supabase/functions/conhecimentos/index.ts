// =====================================================================
// Edge Function: conhecimentos  (cockpit - base de conhecimento por setor)
//   -> CRUD de public.conhecimentos
//
// Base de conhecimento de dominio versionada e administrada no cockpit,
// ENTREGUE pela FILA ao subagente especialista (generica por `setor`). O
// servidor NAO chama LLM; a Lia/subagente consome o conteudo. Conteudo de
// dominio (regras, vocabulario, criterios), NUNCA segredo. Fora das views
// lia.* (SEC-3); escrita com service_role.
//
// Rotas:
//   GET    /conhecimentos                lista (?setor=&ativo=&limit=&offset=)
//   GET    /conhecimentos/:id            1 registro
//   POST   /conhecimentos                cria (setor/titulo/conteudo)
//   PUT    /conhecimentos/:id            atualiza (trigger versiona)
//   DELETE /conhecimentos/:id            remove
//
// Borda: handleCorsPreflight -> assertMethod -> requireAuthorizedUser (401/403)
// -> validacao zod -> roteamento. Mutacoes auditadas via logSensitiveAction.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { assertUuid, deleteRowById, pickDefined, routeSegments } from "../_shared/rest.ts";
import {
  conhecimentoCreateSchema,
  conhecimentoUpdateSchema,
  parseBooleanFilter,
  parseJsonBody,
  parsePagination,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "conhecimentos";
const CONHECIMENTO_COLUMNS =
  "id, setor, titulo, conteudo, ativo, ordem, versao, atualizado_por, atualizado_em, criado_em";

type ServiceClient = ReturnType<typeof createServiceClient>;

// ---------------------------------------------------------------------
// Leitura.
// ---------------------------------------------------------------------

async function listConhecimentos(req: Request): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  const setor = url.searchParams.get("setor")?.trim();
  const ativo = parseBooleanFilter(url.searchParams.get("ativo"));

  let query = db
    .from("conhecimentos")
    .select(CONHECIMENTO_COLUMNS, { count: "exact" })
    .order("setor", { ascending: true })
    .order("ordem", { ascending: true })
    .order("criado_em", { ascending: true })
    .range(offset, offset + limit - 1);

  if (setor) query = query.eq("setor", setor);
  if (ativo !== undefined) query = query.eq("ativo", ativo);

  const { data, count, error } = await query;
  if (error) {
    throw new HttpError(500, "conhecimentos_query_failed", "falha ao listar a base de conhecimento");
  }

  return jsonResponse({ items: data ?? [], total: count ?? 0, limit, offset }, 200);
}

async function getConhecimento(id: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("conhecimentos")
    .select(CONHECIMENTO_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "conhecimento_query_failed", "falha ao consultar o conhecimento");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "conhecimento nao encontrado");
  }

  return jsonResponse(data, 200);
}

// ---------------------------------------------------------------------
// Escrita.
// ---------------------------------------------------------------------

async function createConhecimento(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, conhecimentoCreateSchema);
  const db: ServiceClient = createServiceClient();

  const payload = {
    ...pickDefined(input, ["setor", "titulo", "conteudo", "ativo", "ordem"]),
    atualizado_por: email,
  };

  const { data, error } = await db
    .from("conhecimentos")
    .insert(payload)
    .select(CONHECIMENTO_COLUMNS)
    .single();

  if (error) {
    throw new HttpError(500, "conhecimento_insert_failed", "falha ao criar o conhecimento");
  }

  await logSensitiveAction({
    tabela: "conhecimentos",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { setor: data.setor, titulo: data.titulo, ativo: data.ativo },
  });

  return jsonResponse(data, 201);
}

async function updateConhecimento(req: Request, id: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, conhecimentoUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["setor", "titulo", "conteudo", "ativo", "ordem"]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  // O trigger trg_conhecimentos_updated incrementa `versao` e seta
  // atualizado_em; nao enviamos esses campos no patch.
  payload.atualizado_por = email;

  const { data, error } = await db
    .from("conhecimentos")
    .update(payload)
    .eq("id", id)
    .select(CONHECIMENTO_COLUMNS)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "conhecimento_update_failed", "falha ao atualizar o conhecimento");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "conhecimento nao encontrado");
  }

  await logSensitiveAction({
    tabela: "conhecimentos",
    acao: "atualizar",
    registroId: id,
    usuario: email,
    dadosNovos: { ...payload, versao: data.versao },
  });

  return jsonResponse(data, 200);
}

async function deleteConhecimento(id: string, email: string): Promise<Response> {
  const db = createServiceClient();

  await deleteRowById(db, {
    table: "conhecimentos",
    id,
    recurso: "conhecimento",
    errorCode: "conhecimento_delete_failed",
  });

  await logSensitiveAction({
    tabela: "conhecimentos",
    acao: "remover",
    registroId: id,
    usuario: email,
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// Roteamento.
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "POST", "PUT", "DELETE"]);

    // Autorizacao na borda (401 sem sessao, 403 fora da allowlist).
    const { email } = await requireAuthorizedUser(req);

    const segments = routeSegments(req, FUNCTION_SEGMENT);
    const idRaw = segments[0];

    if (idRaw === undefined) {
      if (req.method === "GET") return await listConhecimentos(req);
      if (req.method === "POST") return await createConhecimento(req, email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
    }

    const id = assertUuid(idRaw, "conhecimento");
    if (req.method === "GET") return await getConhecimento(id);
    if (req.method === "PUT") return await updateConhecimento(req, id, email);
    if (req.method === "DELETE") return await deleteConhecimento(id, email);
    throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET, PUT ou DELETE");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
