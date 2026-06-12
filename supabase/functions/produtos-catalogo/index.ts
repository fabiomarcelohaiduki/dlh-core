// =====================================================================
// Edge Function: produtos-catalogo  (Dominio A - cadastro/hierarquia)
// CRUD de produtos (atributos JSONB validados contra o schema da Linha) +
// CRUD de SKUs (produto_skus) com reindexacao da diretriz_producao em
// memoria_chunks (origem='produto', tipo='produto-cotacao').
//
// Rotas:
//   GET    /produtos-catalogo/produtos                 lista (?linha_id=&limit=&offset=)
//   POST   /produtos-catalogo/produtos                 cria produto (valida atributos)
//   GET    /produtos-catalogo/produtos/:id             detalhe {produto, atributos_schema, skus, imagens}
//   PUT    /produtos-catalogo/produtos/:id             atualiza produto (mesma validacao)
//   DELETE /produtos-catalogo/produtos/:id             remove produto (409 se ha SKUs)
//   POST   /produtos-catalogo/produtos/:id/skus        cria SKU (+ reindex diretriz)
//   GET    /produtos-catalogo/skus/:skuId              detalhe do SKU
//   PUT    /produtos-catalogo/skus/:skuId              atualiza SKU (+ sync diretriz)
//   DELETE /produtos-catalogo/skus/:skuId              remove SKU (+ remove chunks)
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
import { type SupabaseClient } from "@supabase/supabase-js";
import { logSensitiveAction } from "../_shared/audit.ts";
import { removeMemoriaChunks, syncMemoriaChunks } from "../_shared/memoria-reindex.ts";
import {
  assertUuid,
  deleteRowById,
  isForeignKeyViolation,
  isUniqueViolation,
  isUuid,
  pickDefined,
  routeSegments,
} from "../_shared/rest.ts";
import {
  parseJsonBody,
  parsePagination,
  produtoCreateSchema,
  produtoUpdateSchema,
  skuCreateSchema,
  type SkuTipoOrigem,
  skuUpdateSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "produtos-catalogo";

// Discriminadores fixos do chunk de diretriz de producao no indice de memoria.
const CHUNK_ORIGEM = "produto";
const CHUNK_TIPO = "produto-cotacao";

const PRODUTO_COLUMNS =
  "id, linha_id, nome, atributos, prazo_entrega, disponibilidade, pedido_minimo, ativo, created_at, updated_at";
const SKU_COLUMNS =
  "id, produto_id, codigo_sku, tipo_origem, dimensoes, tolerancia_pct, acabamento, peso_gr, diretriz_producao, tempo_producao, estado_calculo, ativo, created_at, updated_at";

interface LinhaAtributoRow {
  chave: string;
  tipo: string;
  obrigatorio: boolean;
}

/** Estado de coerencia de um SKU (campos exclusivos de SKU fabricado). */
interface SkuCoerenciaRow {
  tipo_origem: SkuTipoOrigem;
  diretriz_producao: string | null;
  tempo_producao: number | null;
}

/** True quando a diretriz tem conteudo indexavel (nao-vazia apos trim). */
function hasDiretriz(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

// ---------------------------------------------------------------------
// Validacao de atributos JSONB contra o schema da Linha
// ---------------------------------------------------------------------

/**
 * Carrega a Linha e seu schema de atributos. Quando `exigirAtivo`, rejeita
 * Linha inativa (criterio do POST). Retorna o schema [{chave,tipo,obrigatorio}].
 */
async function loadLinhaSchema(
  db: SupabaseClient,
  linhaId: string,
  exigirAtivo: boolean,
): Promise<LinhaAtributoRow[]> {
  const [linhaRes, atributosRes] = await Promise.all([
    db.from("produto_linhas").select("id, ativo").eq("id", linhaId).maybeSingle(),
    db.from("produto_linha_atributos").select("chave, tipo, obrigatorio").eq("linha_id", linhaId),
  ]);

  if (linhaRes.error) {
    throw new HttpError(500, "linha_query_failed", "falha ao consultar a Linha");
  }
  if (!linhaRes.data) {
    throw new HttpError(400, "linha_invalida", "linha_id nao corresponde a uma Linha existente");
  }
  if (exigirAtivo && linhaRes.data.ativo !== true) {
    throw new HttpError(400, "linha_inativa", "a Linha informada esta inativa");
  }
  if (atributosRes.error) {
    throw new HttpError(500, "atributos_query_failed", "falha ao consultar o schema da Linha");
  }
  return (atributosRes.data ?? []) as LinhaAtributoRow[];
}

/**
 * Valida o mapa de atributos contra o schema da Linha:
 *   - rejeita qualquer chave fora do schema (400);
 *   - exige toda chave obrigatorio=true presente e nao-vazia (400).
 */
function validateAtributos(
  atributos: Record<string, unknown>,
  schema: LinhaAtributoRow[],
): void {
  const permitidas = new Set(schema.map((a) => a.chave));

  for (const chave of Object.keys(atributos)) {
    if (!permitidas.has(chave)) {
      throw new HttpError(
        400,
        "atributo_fora_do_schema",
        `atributo '${chave}' nao pertence ao schema da Linha`,
      );
    }
  }

  for (const atributo of schema) {
    if (!atributo.obrigatorio) continue;
    const valor = atributos[atributo.chave];
    const ausente = valor === undefined || valor === null ||
      (typeof valor === "string" && valor.trim() === "");
    if (ausente) {
      throw new HttpError(
        400,
        "atributo_obrigatorio_ausente",
        `atributo obrigatorio '${atributo.chave}' nao foi informado`,
      );
    }
  }
}

// ---------------------------------------------------------------------
// Produtos
// ---------------------------------------------------------------------

async function listProdutos(req: Request): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  const linhaId = url.searchParams.get("linha_id");

  if (linhaId !== null && !isUuid(linhaId)) {
    throw new HttpError(400, "validation_error", "linha_id invalido (UUID esperado)");
  }

  let query = db
    .from("produtos")
    .select(PRODUTO_COLUMNS, { count: "exact" })
    .order("nome", { ascending: true })
    .range(offset, offset + limit - 1);

  if (linhaId !== null) query = query.eq("linha_id", linhaId);

  const { data, count, error } = await query;
  if (error) {
    throw new HttpError(500, "produtos_query_failed", "falha ao listar os produtos");
  }

  return jsonResponse({ items: data ?? [], total: count ?? 0, limit, offset }, 200);
}

async function getProduto(produtoId: string): Promise<Response> {
  const db = createServiceClient();

  const { data: produto, error: produtoError } = await db
    .from("produtos")
    .select(PRODUTO_COLUMNS)
    .eq("id", produtoId)
    .maybeSingle();
  if (produtoError) {
    throw new HttpError(500, "produto_query_failed", "falha ao consultar o produto");
  }
  if (!produto) {
    throw new HttpError(404, "nao_encontrado", "produto nao encontrado");
  }

  const [schemaRes, skusRes, imagensRes] = await Promise.all([
    db
      .from("produto_linha_atributos")
      .select("chave, tipo, obrigatorio")
      .eq("linha_id", produto.linha_id)
      .order("chave", { ascending: true }),
    db
      .from("produto_skus")
      .select(SKU_COLUMNS)
      .eq("produto_id", produtoId)
      .order("codigo_sku", { ascending: true }),
    db
      .from("produto_imagens")
      .select("id, produto_id, sku_id, storage_path, ordem, legenda, created_at, updated_at")
      .eq("produto_id", produtoId)
      .order("ordem", { ascending: true }),
  ]);

  if (schemaRes.error || skusRes.error || imagensRes.error) {
    throw new HttpError(500, "produto_detalhe_failed", "falha ao montar o detalhe do produto");
  }

  return jsonResponse(
    {
      produto,
      atributos_schema: schemaRes.data ?? [],
      skus: skusRes.data ?? [],
      imagens: imagensRes.data ?? [],
    },
    200,
  );
}

async function createProduto(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, produtoCreateSchema);
  const db = createServiceClient();

  const atributos = (input.atributos ?? {}) as Record<string, unknown>;
  const schema = await loadLinhaSchema(db, input.linha_id, true);
  validateAtributos(atributos, schema);

  const payload: Record<string, unknown> = {
    linha_id: input.linha_id,
    nome: input.nome,
    atributos,
    ...pickDefined(input, ["prazo_entrega", "disponibilidade", "pedido_minimo", "ativo"]),
  };

  const { data, error } = await db.from("produtos").insert(payload).select(PRODUTO_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(500, "produto_insert_failed", "falha ao criar o produto");
  }

  await logSensitiveAction({
    tabela: "produtos",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { linha_id: input.linha_id, nome: input.nome },
  });

  return jsonResponse(data, 201);
}

async function updateProduto(req: Request, produtoId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, produtoUpdateSchema);
  const db = createServiceClient();

  const { data: existing, error: existingError } = await db
    .from("produtos")
    .select("id, linha_id, atributos")
    .eq("id", produtoId)
    .maybeSingle();
  if (existingError) {
    throw new HttpError(500, "produto_query_failed", "falha ao consultar o produto");
  }
  if (!existing) {
    throw new HttpError(404, "nao_encontrado", "produto nao encontrado");
  }

  // Linha efetiva (alteravel) e atributos efetivos para revalidacao do schema.
  const linhaIdEff = input.linha_id ?? existing.linha_id;
  const atributosEff = (input.atributos ?? existing.atributos ?? {}) as Record<string, unknown>;

  if (input.linha_id !== undefined || input.atributos !== undefined) {
    const schema = await loadLinhaSchema(db, linhaIdEff, input.linha_id !== undefined);
    validateAtributos(atributosEff, schema);
  }

  const payload = pickDefined(input, [
    "linha_id",
    "nome",
    "atributos",
    "prazo_entrega",
    "disponibilidade",
    "pedido_minimo",
    "ativo",
  ]);

  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("produtos")
    .update(payload)
    .eq("id", produtoId)
    .select(PRODUTO_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(500, "produto_update_failed", "falha ao atualizar o produto");
  }

  await logSensitiveAction({
    tabela: "produtos",
    acao: "atualizar",
    registroId: produtoId,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deleteProduto(produtoId: string, email: string): Promise<Response> {
  const db = createServiceClient();

  // Bloqueia exclusao quando ha SKUs vinculados (FK ON DELETE RESTRICT).
  const { count, error: countError } = await db
    .from("produto_skus")
    .select("id", { count: "exact", head: true })
    .eq("produto_id", produtoId);
  if (countError) {
    throw new HttpError(500, "skus_count_failed", "falha ao verificar SKUs vinculados");
  }
  if ((count ?? 0) > 0) {
    throw new HttpError(409, "produto_com_skus", "Produto possui SKUs vinculados");
  }

  await deleteRowById(db, {
    table: "produtos",
    id: produtoId,
    recurso: "produto",
    errorCode: "produto_delete_failed",
  });

  await logSensitiveAction({
    tabela: "produtos",
    acao: "remover",
    registroId: produtoId,
    usuario: email,
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// SKUs
// ---------------------------------------------------------------------

/**
 * Garante a coerencia entre tipo_origem e diretriz/tempo de producao:
 * um SKU 'comprado' NAO pode carregar diretriz_producao nem tempo_producao
 * (conceitos exclusivos de SKU fabricado). Violacao -> 400.
 */
function assertTipoOrigemCoerente(state: {
  tipoOrigem: SkuTipoOrigem;
  diretriz: string | null | undefined;
  tempo: number | null | undefined;
}): void {
  if (state.tipoOrigem !== "comprado") return;
  if (hasDiretriz(state.diretriz) || (state.tempo !== null && state.tempo !== undefined)) {
    throw new HttpError(
      400,
      "tipo_origem_incoerente",
      "SKU comprado nao pode ter diretriz_producao nem tempo_producao",
    );
  }
}

async function createSku(req: Request, produtoId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, skuCreateSchema);
  const db = createServiceClient();

  // tipo_origem ja vem com default do schema; coerencia checada antes do insert.
  assertTipoOrigemCoerente({
    tipoOrigem: input.tipo_origem,
    diretriz: input.diretriz_producao ?? null,
    tempo: input.tempo_producao ?? null,
  });

  const payload: Record<string, unknown> = {
    produto_id: produtoId,
    codigo_sku: input.codigo_sku,
    tipo_origem: input.tipo_origem,
    ...pickDefined(input, [
      "dimensoes",
      "tolerancia_pct",
      "acabamento",
      "peso_gr",
      "diretriz_producao",
      "tempo_producao",
      "ativo",
    ]),
  };

  // Insere direto; a FK produto_id valida a existencia do produto (23503 -> 404).
  const { data, error } = await db.from("produto_skus").insert(payload).select(SKU_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "sku_duplicado", "ja existe um SKU com esse codigo_sku");
    }
    if (isForeignKeyViolation(error)) {
      throw new HttpError(404, "nao_encontrado", "produto nao encontrado");
    }
    throw new HttpError(500, "sku_insert_failed", "falha ao criar o SKU");
  }

  // Indexa a diretriz de producao (delete-then-insert idempotente) quando
  // informada; diretriz vazia nao gera chunk.
  await syncMemoriaChunks(db, {
    origem: CHUNK_ORIGEM,
    tipo: CHUNK_TIPO,
    registroId: data.id,
    verbatim: input.diretriz_producao,
  });

  await logSensitiveAction({
    tabela: "produto_skus",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: {
      produto_id: produtoId,
      codigo_sku: input.codigo_sku,
      tipo_origem: input.tipo_origem,
    },
  });

  return jsonResponse(data, 201);
}

async function getSku(skuId: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("produto_skus")
    .select(SKU_COLUMNS)
    .eq("id", skuId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "sku_query_failed", "falha ao consultar o SKU");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "SKU nao encontrado");
  }
  return jsonResponse(data, 200);
}

async function updateSku(req: Request, skuId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, skuUpdateSchema);
  const db = createServiceClient();

  const { data: existing, error: existingError } = await db
    .from("produto_skus")
    .select("tipo_origem, diretriz_producao, tempo_producao")
    .eq("id", skuId)
    .maybeSingle();
  if (existingError) {
    throw new HttpError(500, "sku_query_failed", "falha ao consultar o SKU");
  }
  if (!existing) {
    throw new HttpError(404, "nao_encontrado", "SKU nao encontrado");
  }
  const current = existing as SkuCoerenciaRow;

  // Estado efetivo apos o merge (campos ausentes preservam o valor atual).
  const tipoOrigemEff = input.tipo_origem ?? current.tipo_origem;
  const diretrizEff = input.diretriz_producao !== undefined
    ? input.diretriz_producao
    : current.diretriz_producao;
  const tempoEff = input.tempo_producao !== undefined
    ? input.tempo_producao
    : current.tempo_producao;

  // Coerencia: bloqueia comprado com diretriz/tempo (incl. troca de tipo_origem
  // incompativel com diretriz/tempo ja existentes).
  assertTipoOrigemCoerente({ tipoOrigem: tipoOrigemEff, diretriz: diretrizEff, tempo: tempoEff });

  const payload = pickDefined(input, [
    "codigo_sku",
    "tipo_origem",
    "dimensoes",
    "tolerancia_pct",
    "acabamento",
    "peso_gr",
    "diretriz_producao",
    "tempo_producao",
    "ativo",
  ]);

  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("produto_skus")
    .update(payload)
    .eq("id", skuId)
    .select(SKU_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "sku_duplicado", "ja existe um SKU com esse codigo_sku");
    }
    throw new HttpError(500, "sku_update_failed", "falha ao atualizar o SKU");
  }

  // Sincroniza os chunks SOMENTE quando a diretriz foi tocada no payload:
  // valor nao-vazio reindexa; valor vazio/null remove os chunks do SKU.
  if (input.diretriz_producao !== undefined) {
    await syncMemoriaChunks(db, {
      origem: CHUNK_ORIGEM,
      tipo: CHUNK_TIPO,
      registroId: skuId,
      verbatim: input.diretriz_producao,
    });
  }

  await logSensitiveAction({
    tabela: "produto_skus",
    acao: "atualizar",
    registroId: skuId,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deleteSku(skuId: string, email: string): Promise<Response> {
  const db = createServiceClient();

  await deleteRowById(db, {
    table: "produto_skus",
    id: skuId,
    recurso: "SKU",
    errorCode: "sku_delete_failed",
  });

  // Remove os chunks de diretriz do SKU (idempotente).
  await removeMemoriaChunks(db, { origem: CHUNK_ORIGEM, registroId: skuId });

  await logSensitiveAction({
    tabela: "produto_skus",
    acao: "remover",
    registroId: skuId,
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

    // ----- /skus/:skuId -----
    if (root === "skus") {
      const skuId = assertUuid(segments[1], "SKU");
      if (segments.length > 2) {
        throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
      }
      if (req.method === "GET") return await getSku(skuId);
      if (req.method === "PUT") return await updateSku(req, skuId, email);
      if (req.method === "DELETE") return await deleteSku(skuId, email);
      throw new HttpError(
        405,
        "method_not_allowed",
        "metodo nao permitido: use GET, PUT ou DELETE",
      );
    }

    // ----- /produtos[...] -----
    if (root === "produtos") {
      const produtoIdRaw = segments[1];

      // Colecao: /produtos
      if (produtoIdRaw === undefined) {
        if (req.method === "GET") return await listProdutos(req);
        if (req.method === "POST") return await createProduto(req, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
      }

      const produtoId = assertUuid(produtoIdRaw, "produto");

      // Sub-rota de SKUs: /produtos/:id/skus
      if (segments[2] === "skus") {
        if (segments.length > 3) {
          throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
        }
        if (req.method === "POST") return await createSku(req, produtoId, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use POST");
      }
      if (segments.length > 2) {
        throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
      }

      // Item: /produtos/:id
      if (req.method === "GET") return await getProduto(produtoId);
      if (req.method === "PUT") return await updateProduto(req, produtoId, email);
      if (req.method === "DELETE") return await deleteProduto(produtoId, email);
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
