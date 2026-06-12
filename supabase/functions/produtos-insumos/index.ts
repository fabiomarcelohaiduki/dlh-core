// =====================================================================
// Edge Function: produtos-insumos  (Dominio B - insumos e precos)
// CRUD de insumos (categoria MP/embalagem/insumo) + precos de fornecedor
// com vigencia (historico preservado) + edicao em lote (RNF-15). Os
// triggers da sprint 2 disparam o recalculo dos SKUs afetados; aqui a
// borda apenas grava os dados.
//
// Rotas:
//   GET    /produtos-insumos/insumos                 lista (?ativo=&limit=&offset=)
//   POST   /produtos-insumos/insumos                 cria insumo
//   GET    /produtos-insumos/insumos/:id             detalhe do insumo
//   PUT    /produtos-insumos/insumos/:id             atualiza insumo (incl. ativo)
//   DELETE /produtos-insumos/insumos/:id             remove insumo (409 se em uso)
//   GET    /produtos-insumos/insumos/:id/precos      lista historico de precos
//   POST   /produtos-insumos/insumos/:id/precos      cria nova faixa de vigencia
//   PUT    /produtos-insumos/insumo-precos/batch     edita ate 200 precos (1..200)
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
import {
  assertUuid,
  deleteRowById,
  isForeignKeyViolation,
  pickDefined,
  routeSegments,
} from "../_shared/rest.ts";
import {
  insumoCreateSchema,
  insumoPrecoBatchSchema,
  insumoPrecoCreateSchema,
  insumoUpdateSchema,
  parseBooleanFilter,
  parseJsonBody,
  parsePagination,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "produtos-insumos";

const INSUMO_COLUMNS = "id, nome, categoria, unidade, ativo, created_at, updated_at";
const INSUMO_PRECO_COLUMNS =
  "id, insumo_id, fornecedor, preco, vigencia_inicio, vigencia_fim, created_at, updated_at";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Garante que o insumo existe antes de operar seus precos. */
async function assertInsumoExists(db: ServiceClient, insumoId: string): Promise<void> {
  const { data, error } = await db
    .from("insumos")
    .select("id")
    .eq("id", insumoId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "insumo_query_failed", "falha ao consultar o insumo");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "insumo nao encontrado");
  }
}

// ---------------------------------------------------------------------
// Insumos
// ---------------------------------------------------------------------

async function listInsumos(req: Request): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  const ativo = parseBooleanFilter(url.searchParams.get("ativo"));

  let query = db
    .from("insumos")
    .select(INSUMO_COLUMNS, { count: "exact" })
    .order("nome", { ascending: true })
    .range(offset, offset + limit - 1);

  if (ativo !== undefined) query = query.eq("ativo", ativo);

  const { data, count, error } = await query;
  if (error) {
    throw new HttpError(500, "insumos_query_failed", "falha ao listar os insumos");
  }

  return jsonResponse({ items: data ?? [], total: count ?? 0, limit, offset }, 200);
}

async function getInsumo(insumoId: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("insumos")
    .select(INSUMO_COLUMNS)
    .eq("id", insumoId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "insumo_query_failed", "falha ao consultar o insumo");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "insumo nao encontrado");
  }
  return jsonResponse(data, 200);
}

async function createInsumo(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, insumoCreateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["nome", "categoria", "unidade", "ativo"]);

  const { data, error } = await db.from("insumos").insert(payload).select(INSUMO_COLUMNS).single();
  if (error) {
    throw new HttpError(500, "insumo_insert_failed", "falha ao criar o insumo");
  }

  await logSensitiveAction({
    tabela: "insumos",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { nome: data.nome, categoria: data.categoria, unidade: data.unidade },
  });

  return jsonResponse(data, 201);
}

async function updateInsumo(req: Request, insumoId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, insumoUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["nome", "categoria", "unidade", "ativo"]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("insumos")
    .update(payload)
    .eq("id", insumoId)
    .select(INSUMO_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "insumo_update_failed", "falha ao atualizar o insumo");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "insumo nao encontrado");
  }

  await logSensitiveAction({
    tabela: "insumos",
    acao: "atualizar",
    registroId: insumoId,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deleteInsumo(insumoId: string, email: string): Promise<Response> {
  const db = createServiceClient();

  // Bloqueia exclusao quando o insumo esta referenciado em alguma composicao
  // (FK ON DELETE RESTRICT, simetrico a Linha/Produto). Insumo em uso so sai
  // de circulacao por ativo=false (US-05).
  const { count, error: countError } = await db
    .from("sku_composicao")
    .select("id", { count: "exact", head: true })
    .eq("insumo_id", insumoId);
  if (countError) {
    throw new HttpError(500, "composicao_count_failed", "falha ao verificar uso do insumo");
  }
  if ((count ?? 0) > 0) {
    throw new HttpError(409, "insumo_em_uso", "Insumo referenciado em composicao");
  }

  await deleteRowById(db, {
    table: "insumos",
    id: insumoId,
    recurso: "insumo",
    errorCode: "insumo_delete_failed",
  });

  await logSensitiveAction({
    tabela: "insumos",
    acao: "remover",
    registroId: insumoId,
    usuario: email,
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// Precos de fornecedor (/insumos/:id/precos)
// ---------------------------------------------------------------------

async function listInsumoPrecos(insumoId: string): Promise<Response> {
  const db = createServiceClient();
  await assertInsumoExists(db, insumoId);

  // Historico completo: mais recente primeiro (vigencia_inicio, depois created_at).
  const { data, error } = await db
    .from("insumo_precos")
    .select(INSUMO_PRECO_COLUMNS)
    .eq("insumo_id", insumoId)
    .order("vigencia_inicio", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) {
    throw new HttpError(500, "insumo_precos_query_failed", "falha ao listar os precos do insumo");
  }

  return jsonResponse({ items: data ?? [] }, 200);
}

async function createInsumoPreco(
  req: Request,
  insumoId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, insumoPrecoCreateSchema);
  const db = createServiceClient();
  await assertInsumoExists(db, insumoId);

  // Nova faixa de vigencia: nunca sobrescreve o historico (apenas insere).
  const payload = {
    insumo_id: insumoId,
    preco: input.preco,
    ...pickDefined(input, ["fornecedor", "vigencia_inicio", "vigencia_fim"]),
  };

  const { data, error } = await db
    .from("insumo_precos")
    .insert(payload)
    .select(INSUMO_PRECO_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(500, "insumo_preco_insert_failed", "falha ao criar o preco do insumo");
  }

  await logSensitiveAction({
    tabela: "insumo_precos",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { insumo_id: insumoId, preco: input.preco, fornecedor: input.fornecedor ?? null },
  });

  return jsonResponse(data, 201);
}

// ---------------------------------------------------------------------
// Edicao em lote (/insumo-precos/batch)
// ---------------------------------------------------------------------

async function batchInsumoPrecos(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, insumoPrecoBatchSchema);
  const db = createServiceClient();

  // Cada item cria uma NOVA faixa de vigencia (preserva historico). Os
  // triggers da sprint 2 recalculam, por insert, os SKUs cuja BOM usa o
  // insumo afetado.
  const rows = input.updates.map((u) => ({
    insumo_id: u.insumo_id,
    preco: u.preco,
    ...(u.vigencia_inicio !== undefined ? { vigencia_inicio: u.vigencia_inicio } : {}),
  }));

  const { data, error } = await db.from("insumo_precos").insert(rows).select("id");
  if (error) {
    // insumo_id inexistente -> FK (23503): erro de input, nao do servidor.
    if (isForeignKeyViolation(error)) {
      throw new HttpError(400, "insumo_invalido", "ha insumo_id inexistente no lote");
    }
    throw new HttpError(500, "insumo_precos_batch_failed", "falha ao gravar o lote de precos");
  }

  const updated = data?.length ?? 0;

  // Quantos SKUs foram marcados para recalculo: SKUs distintos cuja BOM usa
  // algum insumo afetado pelo lote.
  const insumoIds = Array.from(new Set(input.updates.map((u) => u.insumo_id)));
  const { data: comps, error: compsError } = await db
    .from("sku_composicao")
    .select("sku_id")
    .in("insumo_id", insumoIds);
  if (compsError) {
    throw new HttpError(500, "composicao_query_failed", "falha ao apurar SKUs afetados");
  }
  const skusMarcadosRecalculo = new Set((comps ?? []).map((c) => c.sku_id)).size;

  await logSensitiveAction({
    tabela: "insumo_precos",
    acao: "editar_lote",
    usuario: email,
    dadosNovos: {
      updated,
      insumos: insumoIds,
      skus_marcados_recalculo: skusMarcadosRecalculo,
    },
  });

  return jsonResponse({ updated, skus_marcados_recalculo: skusMarcadosRecalculo }, 200);
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

    // ----- /insumo-precos/batch -----
    if (root === "insumo-precos") {
      if (segments[1] === "batch" && segments.length === 2) {
        if (req.method === "PUT") return await batchInsumoPrecos(req, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use PUT");
      }
      throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
    }

    // ----- /insumos[...] -----
    if (root === "insumos") {
      const insumoIdRaw = segments[1];

      // Colecao: /insumos
      if (insumoIdRaw === undefined) {
        if (req.method === "GET") return await listInsumos(req);
        if (req.method === "POST") return await createInsumo(req, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
      }

      const insumoId = assertUuid(insumoIdRaw, "insumo");

      // Sub-rota de precos: /insumos/:id/precos
      if (segments[2] === "precos") {
        if (segments.length > 3) {
          throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
        }
        if (req.method === "GET") return await listInsumoPrecos(insumoId);
        if (req.method === "POST") return await createInsumoPreco(req, insumoId, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
      }
      if (segments.length > 2) {
        throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
      }

      // Item: /insumos/:id
      if (req.method === "GET") return await getInsumo(insumoId);
      if (req.method === "PUT") return await updateInsumo(req, insumoId, email);
      if (req.method === "DELETE") return await deleteInsumo(insumoId, email);
      throw new HttpError(
        405,
        "method_not_allowed",
        "metodo nao permitido: use GET, PUT ou DELETE",
      );
    }

    throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
