// =====================================================================
// Edge Function: produtos-revenda  (Dominio D - Revenda)
// CRUD de clientes de revenda + tabela de precos por cliente/SKU com
// HISTORICO de vigencia. Canal SEPARADO do de licitacao (sku_precos_calculados):
// os dois nunca se misturam (RF-16/RF-17). Sem UNIQUE rigido em (cliente, SKU):
// cada par pode ter varios registros ao longo do tempo; uma nova faixa de
// vigencia NUNCA sobrescreve a anterior.
//
// Rotas:
//   GET    /produtos-revenda/clientes-revenda            lista (?ativo=&limit=&offset=)
//   POST   /produtos-revenda/clientes-revenda            cria cliente
//   GET    /produtos-revenda/clientes-revenda/:id        detalhe do cliente
//   PUT    /produtos-revenda/clientes-revenda/:id        atualiza (incl. ativo)
//   GET    /produtos-revenda/clientes-revenda/:id/precos vigente por SKU (?historico=true, ?sku_id=)
//   POST   /produtos-revenda/clientes-revenda/:id/precos cria nova faixa de vigencia
//   PUT    /produtos-revenda/revenda-precos/:id          atualiza faixa
//   DELETE /produtos-revenda/revenda-precos/:id          remove faixa
//
// Borda: handleCorsPreflight -> assertMethod -> requireAuthorizedUser ->
// validacao zod -> roteamento por metodo/sub-path. Escrita server-side via
// service_role (RLS deferida no schema de produtos; autorizacao na borda).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { assertUuid, deleteRowById, isUuid, pickDefined, routeSegments } from "../_shared/rest.ts";
import {
  clienteRevendaCreateSchema,
  clienteRevendaUpdateSchema,
  parseBooleanFilter,
  parseJsonBody,
  parsePagination,
  revendaPrecoCreateSchema,
  revendaPrecoUpdateSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "produtos-revenda";

const CLIENTE_COLUMNS = "id, nome, ativo, created_at, updated_at";
const REVENDA_PRECO_COLUMNS =
  "id, cliente_id, sku_id, preco, vigencia_inicio, vigencia_fim, created_at, updated_at";

type ServiceClient = ReturnType<typeof createServiceClient>;

interface RevendaPrecoRow {
  id: string;
  cliente_id: string;
  sku_id: string;
  preco: number;
  vigencia_inicio: string;
  vigencia_fim: string | null;
  created_at: string;
  updated_at: string;
}

/** Garante que o cliente de revenda existe; 404 quando inexistente. */
async function assertClienteExiste(db: ServiceClient, clienteId: string): Promise<void> {
  const { data, error } = await db
    .from("clientes_revenda")
    .select("id")
    .eq("id", clienteId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "cliente_query_failed", "falha ao consultar o cliente de revenda");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "cliente de revenda nao encontrado");
  }
}

/** Garante que o SKU existe; 404 quando inexistente. */
async function assertSkuExiste(db: ServiceClient, skuId: string): Promise<void> {
  const { data, error } = await db
    .from("produto_skus")
    .select("id")
    .eq("id", skuId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "sku_query_failed", "falha ao consultar o SKU");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "SKU nao encontrado");
  }
}

// ---------------------------------------------------------------------
// Clientes de revenda - /clientes-revenda e /clientes-revenda/:id
// ---------------------------------------------------------------------

async function listClientes(req: Request): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  const ativo = parseBooleanFilter(url.searchParams.get("ativo"));

  let query = db
    .from("clientes_revenda")
    .select(CLIENTE_COLUMNS, { count: "exact" })
    .order("nome", { ascending: true })
    .range(offset, offset + limit - 1);
  if (ativo !== undefined) query = query.eq("ativo", ativo);

  const { data, count, error } = await query;
  if (error) {
    throw new HttpError(500, "clientes_query_failed", "falha ao listar os clientes de revenda");
  }

  return jsonResponse({ items: data ?? [], total: count ?? 0, limit, offset }, 200);
}

async function getCliente(clienteId: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("clientes_revenda")
    .select(CLIENTE_COLUMNS)
    .eq("id", clienteId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "cliente_query_failed", "falha ao consultar o cliente de revenda");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "cliente de revenda nao encontrado");
  }
  return jsonResponse(data, 200);
}

async function createCliente(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, clienteRevendaCreateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["nome", "ativo"]);

  const { data, error } = await db
    .from("clientes_revenda")
    .insert(payload)
    .select(CLIENTE_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(500, "cliente_insert_failed", "falha ao criar o cliente de revenda");
  }

  await logSensitiveAction({
    tabela: "clientes_revenda",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { nome: data.nome, ativo: data.ativo },
  });

  return jsonResponse(data, 201);
}

async function updateCliente(req: Request, clienteId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, clienteRevendaUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["nome", "ativo"]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("clientes_revenda")
    .update(payload)
    .eq("id", clienteId)
    .select(CLIENTE_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "cliente_update_failed", "falha ao atualizar o cliente de revenda");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "cliente de revenda nao encontrado");
  }

  await logSensitiveAction({
    tabela: "clientes_revenda",
    acao: "atualizar",
    registroId: clienteId,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

// ---------------------------------------------------------------------
// Precos de revenda - /clientes-revenda/:id/precos e /revenda-precos/:id
// ---------------------------------------------------------------------

/**
 * Reduz uma lista ordenada (sku_id asc; vigencia_inicio desc; created_at desc)
 * ao preco VIGENTE de cada SKU: a primeira ocorrencia por SKU ja e a vigente.
 */
function vigentesPorSku(rows: RevendaPrecoRow[]): RevendaPrecoRow[] {
  const vistos = new Set<string>();
  const out: RevendaPrecoRow[] = [];
  for (const row of rows) {
    if (vistos.has(row.sku_id)) continue;
    vistos.add(row.sku_id);
    out.push(row);
  }
  return out;
}

async function getPrecos(req: Request, clienteId: string): Promise<Response> {
  const db = createServiceClient();
  await assertClienteExiste(db, clienteId);

  const url = new URL(req.url);
  const historico = parseBooleanFilter(url.searchParams.get("historico")) === true;
  const skuIdRaw = url.searchParams.get("sku_id");
  if (skuIdRaw !== null && !isUuid(skuIdRaw)) {
    throw new HttpError(400, "validation_error", "sku_id deve ser UUID");
  }

  // Historico completo (todos os registros do cliente, ou do par cliente/SKU
  // quando ?sku_id e informado), do mais recente para o mais antigo.
  if (historico) {
    let query = db
      .from("revenda_precos")
      .select(REVENDA_PRECO_COLUMNS)
      .eq("cliente_id", clienteId)
      .order("sku_id", { ascending: true })
      .order("vigencia_inicio", { ascending: false })
      .order("created_at", { ascending: false });
    if (skuIdRaw !== null) query = query.eq("sku_id", skuIdRaw);

    const { data, error } = await query;
    if (error) {
      throw new HttpError(500, "revenda_precos_query_failed", "falha ao listar o historico");
    }
    return jsonResponse({ items: data ?? [] }, 200);
  }

  // Vigente por SKU: maior vigencia_inicio com vigencia_fim nula ou >= hoje;
  // empate desempata por created_at mais recente (mesma regra do custo). A
  // reducao por SKU acontece em memoria sobre a lista ja ordenada.
  const hoje = new Date().toISOString().slice(0, 10);
  let query = db
    .from("revenda_precos")
    .select(REVENDA_PRECO_COLUMNS)
    .eq("cliente_id", clienteId)
    .or(`vigencia_fim.is.null,vigencia_fim.gte.${hoje}`)
    .order("sku_id", { ascending: true })
    .order("vigencia_inicio", { ascending: false })
    .order("created_at", { ascending: false });
  if (skuIdRaw !== null) query = query.eq("sku_id", skuIdRaw);

  const { data, error } = await query;
  if (error) {
    throw new HttpError(
      500,
      "revenda_precos_query_failed",
      "falha ao consultar os precos vigentes",
    );
  }

  const items = vigentesPorSku((data as RevendaPrecoRow[] | null) ?? []);
  return jsonResponse({ items }, 200);
}

async function createPreco(req: Request, clienteId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, revendaPrecoCreateSchema);
  const db = createServiceClient();

  await assertClienteExiste(db, clienteId);
  await assertSkuExiste(db, input.sku_id);

  // Nova faixa de vigencia: nunca sobrescreve o historico (apenas insere).
  const payload = {
    cliente_id: clienteId,
    sku_id: input.sku_id,
    preco: input.preco,
    ...pickDefined(input, ["vigencia_inicio", "vigencia_fim"]),
  };

  const { data, error } = await db
    .from("revenda_precos")
    .insert(payload)
    .select(REVENDA_PRECO_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(500, "revenda_preco_insert_failed", "falha ao criar o preco de revenda");
  }

  await logSensitiveAction({
    tabela: "revenda_precos",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { cliente_id: clienteId, sku_id: input.sku_id, preco: input.preco },
  });

  return jsonResponse(data, 201);
}

async function updatePreco(req: Request, precoId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, revendaPrecoUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["preco", "vigencia_inicio", "vigencia_fim"]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("revenda_precos")
    .update(payload)
    .eq("id", precoId)
    .select(REVENDA_PRECO_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new HttpError(
      500,
      "revenda_preco_update_failed",
      "falha ao atualizar o preco de revenda",
    );
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "preco de revenda nao encontrado");
  }

  await logSensitiveAction({
    tabela: "revenda_precos",
    acao: "atualizar",
    registroId: precoId,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deletePreco(precoId: string, email: string): Promise<Response> {
  const db = createServiceClient();

  await deleteRowById(db, {
    table: "revenda_precos",
    id: precoId,
    recurso: "preco de revenda",
    errorCode: "revenda_preco_delete_failed",
  });

  await logSensitiveAction({
    tabela: "revenda_precos",
    acao: "remover",
    registroId: precoId,
    usuario: email,
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "POST", "PUT", "DELETE"]);

    // Autorizacao na borda (401 sem sessao, 403 fora da allowlist).
    const { email } = await requireAuthorizedUser(req);

    const segments = routeSegments(req, FUNCTION_SEGMENT);
    const root = segments[0];

    // ----- /revenda-precos/:id -----
    if (root === "revenda-precos") {
      const precoId = assertUuid(segments[1], "preco de revenda");
      if (segments.length > 2) {
        throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
      }
      if (req.method === "PUT") return await updatePreco(req, precoId, email);
      if (req.method === "DELETE") return await deletePreco(precoId, email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use PUT ou DELETE");
    }

    // ----- /clientes-revenda[...] -----
    if (root === "clientes-revenda") {
      const clienteIdRaw = segments[1];

      // Colecao: /clientes-revenda
      if (clienteIdRaw === undefined) {
        if (req.method === "GET") return await listClientes(req);
        if (req.method === "POST") return await createCliente(req, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
      }

      const clienteId = assertUuid(clienteIdRaw, "cliente de revenda");

      // Sub-rota de precos: /clientes-revenda/:id/precos
      if (segments[2] === "precos") {
        if (segments.length > 3) {
          throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
        }
        if (req.method === "GET") return await getPrecos(req, clienteId);
        if (req.method === "POST") return await createPreco(req, clienteId, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
      }
      if (segments.length > 2) {
        throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
      }

      // Item: /clientes-revenda/:id
      if (req.method === "GET") return await getCliente(clienteId);
      if (req.method === "PUT") return await updateCliente(req, clienteId, email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou PUT");
    }

    throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
