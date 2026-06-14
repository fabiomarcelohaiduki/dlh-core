// =====================================================================
// Edge Function: produtos-composicao  (Dominio B - BOM e custo de aquisicao)
// CRUD da composicao (BOM) do SKU FABRICADO + CRUD do custo de aquisicao do
// SKU COMPRADO (com historico de vigencia). Os triggers da sprint 2 disparam
// o recalculo dos precos do SKU; aqui a borda apenas grava os dados.
//
// Rotas:
//   GET    /produtos-composicao/skus/:skuId/composicao        lista a BOM
//   POST   /produtos-composicao/skus/:skuId/composicao        cria item da BOM
//   PUT    /produtos-composicao/composicao/:id                atualiza item
//   DELETE /produtos-composicao/composicao/:id                remove item
//   GET    /produtos-composicao/skus/:skuId/custo-aquisicao   vigente (?historico=true)
//   POST   /produtos-composicao/skus/:skuId/custo-aquisicao   cria faixa de vigencia
//   PUT    /produtos-composicao/custo-aquisicao/:id           atualiza faixa
//   DELETE /produtos-composicao/custo-aquisicao/:id           remove faixa
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
  isUniqueViolation,
  pickDefined,
  routeSegments,
} from "../_shared/rest.ts";
import {
  composicaoCreateSchema,
  composicaoUpdateSchema,
  custoAquisicaoCreateSchema,
  custoAquisicaoUpdateSchema,
  parseBooleanFilter,
  parseJsonBody,
  type SkuTipoOrigem,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "produtos-composicao";

const COMPOSICAO_COLUMNS =
  "id, sku_id, insumo_id, quantidade, unidade, rendimento, created_at, updated_at";
const CUSTO_AQUISICAO_COLUMNS =
  "id, sku_id, fornecedor, custo, vigencia_inicio, vigencia_fim, created_at, updated_at";

type ServiceClient = ReturnType<typeof createServiceClient>;

interface SkuRow {
  id: string;
  tipo_origem: SkuTipoOrigem;
}

/** Carrega o SKU (id + tipo_origem); 404 quando inexistente. */
async function loadSku(db: ServiceClient, skuId: string): Promise<SkuRow> {
  const { data, error } = await db
    .from("produto_skus")
    .select("id, tipo_origem")
    .eq("id", skuId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "sku_query_failed", "falha ao consultar o SKU");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "SKU nao encontrado");
  }
  return data as SkuRow;
}

/** Exige SKU fabricado (a BOM e exclusiva de SKU fabricado). */
function assertSkuFabricado(sku: SkuRow): void {
  if (sku.tipo_origem !== "fabricado") {
    throw new HttpError(400, "sku_comprado_sem_bom", "SKU comprado nao tem BOM");
  }
}

/** Exige SKU comprado (custo de aquisicao e exclusivo de SKU comprado). */
function assertSkuComprado(sku: SkuRow): void {
  if (sku.tipo_origem !== "comprado") {
    throw new HttpError(
      400,
      "sku_fabricado_sem_custo",
      "SKU fabricado nao tem custo de aquisicao",
    );
  }
}

/**
 * Valida que o insumo existe e esta ativo (insumo inativo nao e selecionavel
 * em novas composicoes). Falhas viram 400 (input invalido).
 */
async function assertInsumoSelecionavel(db: ServiceClient, insumoId: string): Promise<void> {
  const { data, error } = await db
    .from("insumos")
    .select("id, ativo")
    .eq("id", insumoId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "insumo_query_failed", "falha ao consultar o insumo");
  }
  if (!data) {
    throw new HttpError(400, "insumo_invalido", "insumo nao encontrado");
  }
  if (data.ativo !== true) {
    throw new HttpError(400, "insumo_inativo", "insumo inativo nao pode ser usado em composicao");
  }
}

/** Carrega o item de composicao por id; 404 quando inexistente. */
async function loadComposicao(
  db: ServiceClient,
  composicaoId: string,
): Promise<{ id: string; sku_id: string }> {
  const { data, error } = await db
    .from("sku_composicao")
    .select("id, sku_id")
    .eq("id", composicaoId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "composicao_query_failed", "falha ao consultar a composicao");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "item de composicao nao encontrado");
  }
  return data as { id: string; sku_id: string };
}

// ---------------------------------------------------------------------
// Composicao (BOM) - /skus/:skuId/composicao e /composicao/:id
// ---------------------------------------------------------------------

async function listComposicao(skuId: string): Promise<Response> {
  const db = createServiceClient();
  await loadSku(db, skuId);

  const { data, error } = await db
    .from("sku_composicao")
    .select(COMPOSICAO_COLUMNS)
    .eq("sku_id", skuId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new HttpError(500, "composicao_query_failed", "falha ao listar a composicao");
  }

  return jsonResponse({ items: data ?? [] }, 200);
}

async function createComposicao(req: Request, skuId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, composicaoCreateSchema);
  const db = createServiceClient();

  const sku = await loadSku(db, skuId);
  assertSkuFabricado(sku);
  await assertInsumoSelecionavel(db, input.insumo_id);

  // Quando o rendimento e informado (pecas que 1 unidade de material rende),
  // a quantidade por peca e derivada (= 1 / rendimento) para nunca divergir do
  // que o usuario digitou. Sem rendimento, usa a quantidade informada direto.
  const rendimento = input.rendimento ?? null;
  const quantidade =
    rendimento != null && rendimento > 0 ? 1 / rendimento : input.quantidade;

  const payload = {
    sku_id: skuId,
    insumo_id: input.insumo_id,
    quantidade,
    rendimento,
    ...pickDefined(input, ["unidade"]),
  };

  const { data, error } = await db
    .from("sku_composicao")
    .insert(payload)
    .select(COMPOSICAO_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "insumo_ja_na_composicao", "Insumo ja esta na composicao");
    }
    throw new HttpError(500, "composicao_insert_failed", "falha ao criar o item de composicao");
  }

  await logSensitiveAction({
    tabela: "sku_composicao",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { sku_id: skuId, insumo_id: input.insumo_id, quantidade, rendimento },
  });

  return jsonResponse(data, 201);
}

async function updateComposicao(
  req: Request,
  composicaoId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, composicaoUpdateSchema);
  const db = createServiceClient();

  await loadComposicao(db, composicaoId);

  // Troca de insumo so para insumo ativo (inativo nao e selecionavel).
  if (input.insumo_id !== undefined) {
    await assertInsumoSelecionavel(db, input.insumo_id);
  }

  const payload = pickDefined(input, ["insumo_id", "quantidade", "unidade", "rendimento"]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  // Rendimento informado (>0) deriva a quantidade; null limpa o rendimento sem
  // mexer na quantidade. Mantem quantidade e rendimento sempre coerentes.
  if (input.rendimento != null && input.rendimento > 0) {
    payload.quantidade = 1 / input.rendimento;
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("sku_composicao")
    .update(payload)
    .eq("id", composicaoId)
    .select(COMPOSICAO_COLUMNS)
    .maybeSingle();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "insumo_ja_na_composicao", "Insumo ja esta na composicao");
    }
    throw new HttpError(500, "composicao_update_failed", "falha ao atualizar a composicao");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "item de composicao nao encontrado");
  }

  await logSensitiveAction({
    tabela: "sku_composicao",
    acao: "atualizar",
    registroId: composicaoId,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deleteComposicao(composicaoId: string, email: string): Promise<Response> {
  const db = createServiceClient();

  await deleteRowById(db, {
    table: "sku_composicao",
    id: composicaoId,
    recurso: "item de composicao",
    errorCode: "composicao_delete_failed",
  });

  await logSensitiveAction({
    tabela: "sku_composicao",
    acao: "remover",
    registroId: composicaoId,
    usuario: email,
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// Custo de aquisicao - /skus/:skuId/custo-aquisicao e /custo-aquisicao/:id
// ---------------------------------------------------------------------

async function getCustoAquisicao(req: Request, skuId: string): Promise<Response> {
  const db = createServiceClient();
  await loadSku(db, skuId);

  const url = new URL(req.url);
  const historico = parseBooleanFilter(url.searchParams.get("historico")) === true;

  if (historico) {
    const { data, error } = await db
      .from("sku_custo_aquisicao")
      .select(CUSTO_AQUISICAO_COLUMNS)
      .eq("sku_id", skuId)
      .order("vigencia_inicio", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) {
      throw new HttpError(500, "custo_aquisicao_query_failed", "falha ao listar o historico");
    }
    return jsonResponse({ items: data ?? [] }, 200);
  }

  // Vigente: maior vigencia_inicio com vigencia_fim nula ou >= hoje
  // (empate desempata por created_at mais recente). Mesma regra do motor.
  const hoje = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from("sku_custo_aquisicao")
    .select(CUSTO_AQUISICAO_COLUMNS)
    .eq("sku_id", skuId)
    .or(`vigencia_fim.is.null,vigencia_fim.gte.${hoje}`)
    .order("vigencia_inicio", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "custo_aquisicao_query_failed", "falha ao consultar o custo vigente");
  }

  return jsonResponse(data ?? null, 200);
}

async function createCustoAquisicao(
  req: Request,
  skuId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, custoAquisicaoCreateSchema);
  const db = createServiceClient();

  const sku = await loadSku(db, skuId);
  assertSkuComprado(sku);

  // Nova faixa de vigencia: nunca sobrescreve o historico (apenas insere).
  const payload = {
    sku_id: skuId,
    custo: input.custo,
    ...pickDefined(input, ["fornecedor", "vigencia_inicio", "vigencia_fim"]),
  };

  const { data, error } = await db
    .from("sku_custo_aquisicao")
    .insert(payload)
    .select(CUSTO_AQUISICAO_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(
      500,
      "custo_aquisicao_insert_failed",
      "falha ao criar o custo de aquisicao",
    );
  }

  await logSensitiveAction({
    tabela: "sku_custo_aquisicao",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { sku_id: skuId, custo: input.custo, fornecedor: input.fornecedor ?? null },
  });

  return jsonResponse(data, 201);
}

async function updateCustoAquisicao(
  req: Request,
  custoId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, custoAquisicaoUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["fornecedor", "custo", "vigencia_inicio", "vigencia_fim"]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("sku_custo_aquisicao")
    .update(payload)
    .eq("id", custoId)
    .select(CUSTO_AQUISICAO_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new HttpError(
      500,
      "custo_aquisicao_update_failed",
      "falha ao atualizar o custo de aquisicao",
    );
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "custo de aquisicao nao encontrado");
  }

  await logSensitiveAction({
    tabela: "sku_custo_aquisicao",
    acao: "atualizar",
    registroId: custoId,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deleteCustoAquisicao(custoId: string, email: string): Promise<Response> {
  const db = createServiceClient();

  await deleteRowById(db, {
    table: "sku_custo_aquisicao",
    id: custoId,
    recurso: "custo de aquisicao",
    errorCode: "custo_aquisicao_delete_failed",
  });

  await logSensitiveAction({
    tabela: "sku_custo_aquisicao",
    acao: "remover",
    registroId: custoId,
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

    // ----- /composicao/:id -----
    if (root === "composicao") {
      const composicaoId = assertUuid(segments[1], "item de composicao");
      if (segments.length > 2) {
        throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
      }
      if (req.method === "PUT") return await updateComposicao(req, composicaoId, email);
      if (req.method === "DELETE") return await deleteComposicao(composicaoId, email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use PUT ou DELETE");
    }

    // ----- /custo-aquisicao/:id -----
    if (root === "custo-aquisicao") {
      const custoId = assertUuid(segments[1], "custo de aquisicao");
      if (segments.length > 2) {
        throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
      }
      if (req.method === "PUT") return await updateCustoAquisicao(req, custoId, email);
      if (req.method === "DELETE") return await deleteCustoAquisicao(custoId, email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use PUT ou DELETE");
    }

    // ----- /skus/:skuId/{composicao|custo-aquisicao} -----
    if (root === "skus") {
      const skuId = assertUuid(segments[1], "SKU");
      const sub = segments[2];
      if (segments.length > 3) {
        throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
      }

      if (sub === "composicao") {
        if (req.method === "GET") return await listComposicao(skuId);
        if (req.method === "POST") return await createComposicao(req, skuId, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
      }

      if (sub === "custo-aquisicao") {
        if (req.method === "GET") return await getCustoAquisicao(req, skuId);
        if (req.method === "POST") return await createCustoAquisicao(req, skuId, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
      }

      throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
    }

    throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
