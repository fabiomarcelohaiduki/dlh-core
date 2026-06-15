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
//   GET    /produtos-catalogo/produtos/:id/atributos       lista atributos do Produto
//   POST   /produtos-catalogo/produtos/:id/atributos       cria atributo (chave unica/sem colisao Linha -> 409)
//   DELETE /produtos-catalogo/produtos/:id/atributos/:aid  remove atributo do Produto
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
  linhaAtributoCreateSchema,
  linhaAtributoUpdateSchema,
  parseJsonBody,
  parsePagination,
  produtoCreateSchema,
  produtoUpdateSchema,
  skuCreateSchema,
  type SkuTipoOrigem,
  type SkuUnidadeTempo,
  skuUpdateSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "produtos-catalogo";

// Discriminadores fixos do chunk de diretriz de producao no indice de memoria.
const CHUNK_ORIGEM = "produto";
const CHUNK_TIPO = "produto-cotacao";

// Bucket privado das imagens de Produto/SKU (mesmo de produtos-imagens).
const PRODUTOS_BUCKET = "produtos";

const PRODUTO_COLUMNS =
  "id, linha_id, nome, descricao, atributos, prazo_entrega, disponibilidade, pedido_minimo, ativo, created_at, updated_at";
const SKU_COLUMNS =
  "id, produto_id, codigo_sku, tipo_origem, atributos, dimensoes, tolerancia_pct, acabamento, peso_gr, diretriz_producao, tamanho_lote, tempo_lote, unidade_tempo, tempo_producao, estado_calculo, ativo, created_at, updated_at";
const PRODUTO_ATRIBUTO_COLUMNS =
  "id, produto_id, chave, tipo, obrigatorio, mostra_catalogo, mostra_ficha, created_at, updated_at";

// Bucket privado das imagens; TTL da URL assinada nos documentos (1h).
const DOC_SIGNED_URL_TTL_SECONDS = 3600;

interface LinhaAtributoRow {
  chave: string;
  tipo: string;
  obrigatorio: boolean;
}

/** Estado de coerencia de um SKU (campos exclusivos de SKU fabricado). */
interface SkuCoerenciaRow {
  tipo_origem: SkuTipoOrigem;
  diretriz_producao: string | null;
  tamanho_lote: number | null;
  tempo_lote: number | null;
  unidade_tempo: SkuUnidadeTempo | null;
}

/**
 * Jornada (horas/dia) do nivel global; usada para converter lote em "dia"
 * para horas. Fallback 8h quando nao configurada em Parametros.
 */
async function getHorasPorDia(db: SupabaseClient): Promise<number> {
  const { data } = await db
    .from("parametros_calculo")
    .select("horas_por_dia")
    .eq("nivel", "global")
    .is("escopo_id", null)
    .maybeSingle();
  const h = (data as { horas_por_dia: number | null } | null)?.horas_por_dia;
  return typeof h === "number" && h > 0 ? h : 8;
}

/**
 * Deriva tempo_producao (h por unidade) a partir do lote:
 *   tempo_producao = tempo_lote * fator(unidade) / tamanho_lote
 *   fator: hora = 1 ; dia = horas_por_dia.
 * Lote incompleto (tamanho ausente/<=0 ou tempo ausente) => null (sem MOD).
 */
function deriveTempoProducao(
  tamanhoLote: number | null | undefined,
  tempoLote: number | null | undefined,
  unidadeTempo: SkuUnidadeTempo | null | undefined,
  horasPorDia: number,
): number | null {
  if (tamanhoLote == null || tamanhoLote <= 0) return null;
  if (tempoLote == null) return null;
  const fator = unidadeTempo === "dia" ? horasPorDia : 1;
  return (tempoLote * fator) / tamanhoLote;
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

/** Schema de atributos PROPRIOS do Produto (produto_atributos). */
async function loadProdutoAtributos(
  db: SupabaseClient,
  produtoId: string,
): Promise<LinhaAtributoRow[]> {
  const { data, error } = await db
    .from("produto_atributos")
    .select("chave, tipo, obrigatorio")
    .eq("produto_id", produtoId);
  if (error) {
    throw new HttpError(500, "atributos_query_failed", "falha ao consultar o schema do Produto");
  }
  return (data ?? []) as LinhaAtributoRow[];
}

/**
 * Schema que o SKU preenche (CASCATA): os atributos da Linha (herdados, com
 * valor preenchido no Produto) MAIS os proprios do Produto. O SKU exibe e pode
 * sobrescrever ambos por SKU. Valida a existencia do Produto (404) antes.
 */
async function loadSkuSchema(
  db: SupabaseClient,
  produtoId: string,
): Promise<LinhaAtributoRow[]> {
  const { data: produto, error } = await db
    .from("produtos")
    .select("id, linha_id")
    .eq("id", produtoId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "produto_query_failed", "falha ao consultar o produto");
  }
  if (!produto) {
    throw new HttpError(404, "nao_encontrado", "produto nao encontrado");
  }
  const [linhaSchema, produtoSchema] = await Promise.all([
    loadLinhaSchema(db, produto.linha_id as string, false),
    loadProdutoAtributos(db, produtoId),
  ]);
  return [...linhaSchema, ...produtoSchema];
}

/**
 * Valida o mapa de atributos de um nivel contra o schema que ele preenche
 * (Produto preenche o schema da Linha; SKU preenche o schema proprio do
 * Produto):
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
        `atributo '${chave}' nao pertence ao schema deste nivel`,
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
// Fotos (thumbnail das listagens)
// ---------------------------------------------------------------------

/**
 * Resolve a 1a foto (por `ordem`) de cada id de Produto ou SKU em signed URL.
 * Le `produto_imagens` filtrando por `coluna`, pega a 1a path por id e assina
 * tudo num unico lote. Retorna id -> signed URL (ausencia = sem foto).
 */
async function resolverFotoUrls(
  db: SupabaseClient,
  coluna: "produto_id" | "sku_id",
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;

  const { data, error } = await db
    .from("produto_imagens")
    .select(`${coluna}, storage_path, ordem`)
    .in(coluna, ids)
    .order("ordem", { ascending: true });
  if (error || !data) return out;

  const pathPorId = new Map<string, string>();
  for (const r of data as Array<Record<string, unknown>>) {
    const id = r[coluna] as string | null;
    const path = r.storage_path as string | null;
    if (id && path && !pathPorId.has(id)) pathPorId.set(id, path);
  }

  const paths = [...new Set(pathPorId.values())];
  if (paths.length === 0) return out;

  const signed = await db.storage
    .from(PRODUTOS_BUCKET)
    .createSignedUrls(paths, DOC_SIGNED_URL_TTL_SECONDS);
  if (signed.error) return out;

  const urlPorPath = new Map<string, string>();
  for (const s of signed.data ?? []) {
    if (s.path && s.signedUrl) urlPorPath.set(s.path, s.signedUrl);
  }
  for (const [id, path] of pathPorId) {
    const u = urlPorPath.get(path);
    if (u) out.set(id, u);
  }
  return out;
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

  const items = data ?? [];
  const fotoPorProduto = await resolverFotoUrls(
    db,
    "produto_id",
    items.map((p) => p.id),
  );
  const itemsComFoto = items.map((p) => ({
    ...p,
    foto_url: fotoPorProduto.get(p.id) ?? null,
  }));

  return jsonResponse({ items: itemsComFoto, total: count ?? 0, limit, offset }, 200);
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

  const [linhaSchemaRes, produtoSchemaRes, skusRes, imagensRes] = await Promise.all([
    db
      .from("produto_linha_atributos")
      .select("chave, tipo, obrigatorio, mostra_catalogo, mostra_ficha")
      .eq("linha_id", produto.linha_id)
      .order("chave", { ascending: true }),
    db
      .from("produto_atributos")
      .select("chave, tipo, obrigatorio, mostra_catalogo, mostra_ficha")
      .eq("produto_id", produtoId)
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

  if (linhaSchemaRes.error || produtoSchemaRes.error || skusRes.error || imagensRes.error) {
    throw new HttpError(500, "produto_detalhe_failed", "falha ao montar o detalhe do produto");
  }

  // Schema efetivo = atributos da Linha (herdados) + atributos proprios do
  // Produto. origem discrimina a procedencia para a UI; sem colisao de chave
  // (barrada na criacao do atributo do Produto).
  const atributos_schema = [
    ...(linhaSchemaRes.data ?? []).map((a) => ({ ...a, origem: "linha" as const })),
    ...(produtoSchemaRes.data ?? []).map((a) => ({ ...a, origem: "produto" as const })),
  ];

  const skus = skusRes.data ?? [];
  const fotoPorSku = await resolverFotoUrls(
    db,
    "sku_id",
    skus.map((s) => s.id),
  );
  const skusComFoto = skus.map((s) => ({
    ...s,
    foto_url: fotoPorSku.get(s.id) ?? null,
  }));

  return jsonResponse(
    {
      produto,
      atributos_schema,
      skus: skusComFoto,
      imagens: imagensRes.data ?? [],
    },
    200,
  );
}

async function createProduto(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, produtoCreateSchema);
  const db = createServiceClient();

  const atributos = (input.atributos ?? {}) as Record<string, unknown>;
  // Produto preenche os atributos definidos na Linha (obrigatorios exigidos).
  const schema = await loadLinhaSchema(db, input.linha_id, true);
  validateAtributos(atributos, schema);

  const payload: Record<string, unknown> = {
    linha_id: input.linha_id,
    nome: input.nome,
    atributos,
    ...pickDefined(input, ["descricao", "prazo_entrega", "disponibilidade", "pedido_minimo", "ativo"]),
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
    // Produto preenche os atributos definidos na Linha (obrigatorios exigidos).
    const linhaSchema = await loadLinhaSchema(db, linhaIdEff, input.linha_id !== undefined);
    validateAtributos(atributosEff, linhaSchema);
  }

  const payload = pickDefined(input, [
    "linha_id",
    "nome",
    "descricao",
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

  // Limpa os DERIVADOS proprios do Produto (existem so enquanto o produto
  // existe, nao sao compartilhados): atributos proprios e imagens (Storage).
  const { error: atributosError } = await db
    .from("produto_atributos")
    .delete()
    .eq("produto_id", produtoId);
  if (atributosError) {
    throw new HttpError(500, "produto_atributos_delete_failed", "falha ao remover atributos do produto");
  }

  const { data: imagens, error: imagensError } = await db
    .from("produto_imagens")
    .select("storage_path")
    .eq("produto_id", produtoId);
  if (imagensError) {
    throw new HttpError(500, "produto_imagens_read_failed", "falha ao ler imagens do produto");
  }
  if (imagens && imagens.length > 0) {
    const paths = imagens
      .map((i) => i.storage_path as string | null)
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      // Idempotente: remover do Storage nao falha se o objeto ja sumiu.
      await db.storage.from(PRODUTOS_BUCKET).remove(paths);
    }
    const { error: imagensDelError } = await db
      .from("produto_imagens")
      .delete()
      .eq("produto_id", produtoId);
    if (imagensDelError) {
      throw new HttpError(500, "produto_imagens_delete_failed", "falha ao remover imagens do produto");
    }
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
// Atributos proprios do Produto (/produtos/:id/atributos)
// ---------------------------------------------------------------------

async function listProdutoAtributos(produtoId: string): Promise<Response> {
  const db = createServiceClient();

  const { data: produto, error: produtoError } = await db
    .from("produtos")
    .select("id")
    .eq("id", produtoId)
    .maybeSingle();
  if (produtoError) {
    throw new HttpError(500, "produto_query_failed", "falha ao consultar o produto");
  }
  if (!produto) {
    throw new HttpError(404, "nao_encontrado", "produto nao encontrado");
  }

  const { data, error } = await db
    .from("produto_atributos")
    .select(PRODUTO_ATRIBUTO_COLUMNS)
    .eq("produto_id", produtoId)
    .order("chave", { ascending: true });
  if (error) {
    throw new HttpError(500, "atributos_query_failed", "falha ao listar os atributos do Produto");
  }

  return jsonResponse({ items: data ?? [] }, 200);
}

async function createProdutoAtributo(
  req: Request,
  produtoId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, linhaAtributoCreateSchema);
  const db = createServiceClient();

  const { data: produto, error: produtoError } = await db
    .from("produtos")
    .select("id, linha_id")
    .eq("id", produtoId)
    .maybeSingle();
  if (produtoError) {
    throw new HttpError(500, "produto_query_failed", "falha ao consultar o produto");
  }
  if (!produto) {
    throw new HttpError(404, "nao_encontrado", "produto nao encontrado");
  }

  // Colisao com atributo herdado da Linha -> 409 (sem ambiguidade de precedencia).
  const { data: colisao, error: colisaoError } = await db
    .from("produto_linha_atributos")
    .select("id")
    .eq("linha_id", produto.linha_id)
    .eq("chave", input.chave)
    .maybeSingle();
  if (colisaoError) {
    throw new HttpError(500, "atributos_query_failed", "falha ao verificar o schema da Linha");
  }
  if (colisao) {
    throw new HttpError(
      409,
      "atributo_colide_linha",
      "ja existe um atributo com essa chave herdado da Linha",
    );
  }

  const payload = {
    produto_id: produtoId,
    ...pickDefined(input, ["chave", "tipo", "obrigatorio", "mostra_catalogo", "mostra_ficha"]),
  };

  const { data, error } = await db
    .from("produto_atributos")
    .insert(payload)
    .select(PRODUTO_ATRIBUTO_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(
        409,
        "atributo_duplicado",
        "ja existe um atributo com essa chave no Produto",
      );
    }
    throw new HttpError(500, "atributo_insert_failed", "falha ao criar o atributo");
  }

  await logSensitiveAction({
    tabela: "produto_atributos",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { produto_id: produtoId, chave: data.chave, tipo: data.tipo },
  });

  return jsonResponse(data, 201);
}

async function updateProdutoAtributo(
  req: Request,
  produtoId: string,
  atributoId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, linhaAtributoUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, [
    "chave",
    "tipo",
    "obrigatorio",
    "mostra_catalogo",
    "mostra_ficha",
  ]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }

  // Renomear a chave nao pode colidir com um atributo herdado da Linha.
  if (typeof payload.chave === "string") {
    const { data: produto, error: produtoError } = await db
      .from("produtos")
      .select("linha_id")
      .eq("id", produtoId)
      .maybeSingle();
    if (produtoError) {
      throw new HttpError(500, "produto_query_failed", "falha ao consultar o produto");
    }
    if (!produto) {
      throw new HttpError(404, "nao_encontrado", "produto nao encontrado");
    }
    const { data: colisao, error: colisaoError } = await db
      .from("produto_linha_atributos")
      .select("id")
      .eq("linha_id", produto.linha_id)
      .eq("chave", payload.chave)
      .maybeSingle();
    if (colisaoError) {
      throw new HttpError(500, "atributos_query_failed", "falha ao verificar o schema da Linha");
    }
    if (colisao) {
      throw new HttpError(
        409,
        "atributo_colide_linha",
        "ja existe um atributo com essa chave herdado da Linha",
      );
    }
  }

  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("produto_atributos")
    .update(payload)
    .eq("id", atributoId)
    .eq("produto_id", produtoId)
    .select(PRODUTO_ATRIBUTO_COLUMNS)
    .maybeSingle();

  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(
        409,
        "atributo_duplicado",
        "ja existe um atributo com essa chave no Produto",
      );
    }
    throw new HttpError(500, "atributo_update_failed", "falha ao atualizar o atributo");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "atributo nao encontrado");
  }

  await logSensitiveAction({
    tabela: "produto_atributos",
    acao: "atualizar",
    registroId: atributoId,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deleteProdutoAtributo(
  produtoId: string,
  atributoId: string,
  email: string,
): Promise<Response> {
  const db = createServiceClient();

  await deleteRowById(db, {
    table: "produto_atributos",
    id: atributoId,
    extraEq: { produto_id: produtoId },
    recurso: "atributo",
    errorCode: "atributo_delete_failed",
  });

  await logSensitiveAction({
    tabela: "produto_atributos",
    acao: "remover",
    registroId: atributoId,
    usuario: email,
    dadosAnteriores: { produto_id: produtoId },
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// SKUs
// ---------------------------------------------------------------------

/**
 * Garante a coerencia entre tipo_origem e diretriz/lote de producao:
 * um SKU 'comprado' NAO pode carregar diretriz_producao nem lote de producao
 * (conceitos exclusivos de SKU fabricado). Violacao -> 400.
 */
function assertTipoOrigemCoerente(state: {
  tipoOrigem: SkuTipoOrigem;
  diretriz: string | null | undefined;
  tamanhoLote: number | null | undefined;
  tempoLote: number | null | undefined;
}): void {
  if (state.tipoOrigem !== "comprado") return;
  const temLote = (state.tamanhoLote !== null && state.tamanhoLote !== undefined) ||
    (state.tempoLote !== null && state.tempoLote !== undefined);
  if (hasDiretriz(state.diretriz) || temLote) {
    throw new HttpError(
      400,
      "tipo_origem_incoerente",
      "SKU comprado nao pode ter diretriz_producao nem lote de producao",
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
    tamanhoLote: input.tamanho_lote ?? null,
    tempoLote: input.tempo_lote ?? null,
  });

  // Valores de atributo do SKU validados contra o schema mesclado (Linha +
  // Produto); aqui os obrigatorios sao exigidos. Tambem valida a existencia
  // do produto (404).
  const atributos = (input.atributos ?? {}) as Record<string, unknown>;
  const schema = await loadSkuSchema(db, produtoId);
  validateAtributos(atributos, schema);

  // tempo_producao e DERIVADO do lote (nunca informado pelo cliente).
  const tempoProducao = deriveTempoProducao(
    input.tamanho_lote,
    input.tempo_lote,
    input.unidade_tempo ?? null,
    await getHorasPorDia(db),
  );

  const payload: Record<string, unknown> = {
    produto_id: produtoId,
    codigo_sku: input.codigo_sku,
    tipo_origem: input.tipo_origem,
    atributos,
    tempo_producao: tempoProducao,
    ...pickDefined(input, [
      "dimensoes",
      "tolerancia_pct",
      "acabamento",
      "peso_gr",
      "diretriz_producao",
      "tamanho_lote",
      "tempo_lote",
      "unidade_tempo",
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
    .select("produto_id, tipo_origem, diretriz_producao, tamanho_lote, tempo_lote, unidade_tempo")
    .eq("id", skuId)
    .maybeSingle();
  if (existingError) {
    throw new HttpError(500, "sku_query_failed", "falha ao consultar o SKU");
  }
  if (!existing) {
    throw new HttpError(404, "nao_encontrado", "SKU nao encontrado");
  }
  const current = existing as SkuCoerenciaRow & { produto_id: string };

  // Quando os atributos sao tocados, revalida o mapa (substituicao total)
  // contra o schema mesclado (Linha + Produto), exigindo os obrigatorios.
  if (input.atributos !== undefined) {
    const schema = await loadSkuSchema(db, current.produto_id);
    validateAtributos((input.atributos ?? {}) as Record<string, unknown>, schema);
  }

  // Estado efetivo apos o merge (campos ausentes preservam o valor atual).
  const tipoOrigemEff = input.tipo_origem ?? current.tipo_origem;
  const diretrizEff = input.diretriz_producao !== undefined
    ? input.diretriz_producao
    : current.diretriz_producao;
  const tamanhoLoteEff = input.tamanho_lote !== undefined
    ? input.tamanho_lote
    : current.tamanho_lote;
  const tempoLoteEff = input.tempo_lote !== undefined
    ? input.tempo_lote
    : current.tempo_lote;
  const unidadeTempoEff = input.unidade_tempo !== undefined
    ? input.unidade_tempo
    : current.unidade_tempo;

  // Coerencia: bloqueia comprado com diretriz/lote (incl. troca de tipo_origem
  // incompativel com diretriz/lote ja existentes).
  assertTipoOrigemCoerente({
    tipoOrigem: tipoOrigemEff,
    diretriz: diretrizEff,
    tamanhoLote: tamanhoLoteEff,
    tempoLote: tempoLoteEff,
  });

  const payload = pickDefined(input, [
    "codigo_sku",
    "tipo_origem",
    "atributos",
    "dimensoes",
    "tolerancia_pct",
    "acabamento",
    "peso_gr",
    "diretriz_producao",
    "tamanho_lote",
    "tempo_lote",
    "unidade_tempo",
    "ativo",
  ]);

  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }

  // Recalcula tempo_producao (derivado) quando o lote ou o tipo de origem
  // foram tocados; o trigger so dispara recalculo se o valor mudar de fato.
  const loteTocado = input.tamanho_lote !== undefined ||
    input.tempo_lote !== undefined ||
    input.unidade_tempo !== undefined ||
    input.tipo_origem !== undefined;
  if (loteTocado) {
    payload.tempo_producao = deriveTempoProducao(
      tamanhoLoteEff,
      tempoLoteEff,
      unidadeTempoEff,
      await getHorasPorDia(db),
    );
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

  // Bloqueia (409) quando ha vinculos de NEGOCIO do usuario (FK ON DELETE
  // RESTRICT): composicao, custo de aquisicao e precos de revenda. Estes
  // representam decisao/dado do usuario e exigem remocao explicita antes.
  for (const tabela of ["sku_composicao", "sku_custo_aquisicao", "revenda_precos"]) {
    const { count, error } = await db
      .from(tabela)
      .select("id", { count: "exact", head: true })
      .eq("sku_id", skuId);
    if (error) {
      throw new HttpError(500, "sku_vinculos_failed", "falha ao verificar vinculos do SKU");
    }
    if ((count ?? 0) > 0) {
      throw new HttpError(
        409,
        "sku_com_vinculos",
        "SKU possui vinculos (composicao/custo) e nao pode ser removido",
      );
    }
  }

  // Limpa os DERIVADOS do proprio SKU (gerados/anexados, sem decisao de
  // negocio): precos calculados pelo motor IFP e imagens (objeto no Storage).
  const { error: precosError } = await db
    .from("sku_precos_calculados")
    .delete()
    .eq("sku_id", skuId);
  if (precosError) {
    throw new HttpError(500, "sku_precos_delete_failed", "falha ao remover precos calculados");
  }

  const { data: imagens, error: imagensError } = await db
    .from("produto_imagens")
    .select("storage_path")
    .eq("sku_id", skuId);
  if (imagensError) {
    throw new HttpError(500, "sku_imagens_read_failed", "falha ao ler imagens do SKU");
  }
  if (imagens && imagens.length > 0) {
    const paths = imagens
      .map((i) => i.storage_path as string | null)
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      // Idempotente: remover do Storage nao falha se o objeto ja sumiu.
      await db.storage.from(PRODUTOS_BUCKET).remove(paths);
    }
    const { error: imagensDelError } = await db
      .from("produto_imagens")
      .delete()
      .eq("sku_id", skuId);
    if (imagensDelError) {
      throw new HttpError(500, "sku_imagens_delete_failed", "falha ao remover imagens do SKU");
    }
  }

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
// GET /documentos-dados?linha_id=:uuid
// Dados agregados de uma Linha para os documentos imprimiveis (Catalogo e
// Ficha tecnica): schema de atributos da Linha (com flags de visibilidade),
// e por Produto seus atributos proprios, valores, foto e SKUs (valores +
// foto). Leitura em lote (poucas queries) com URLs de imagem assinadas.
// Somente leitura.
// ---------------------------------------------------------------------

interface DocAtributo {
  chave: string;
  tipo: string;
  obrigatorio: boolean;
  mostra_catalogo: boolean;
  mostra_ficha: boolean;
}

/** Le todas as linhas de uma tabela por `col in ids`, paginando o teto de 1000. */
async function fetchAllByIn<T>(
  db: SupabaseClient,
  table: string,
  columns: string,
  col: string,
  ids: string[],
  orderCol: string,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const out: T[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .in(col, ids)
      .order(orderCol, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      throw new HttpError(500, "documentos_query_failed", `falha ao consultar ${table}`);
    }
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function getDocumentosDados(req: Request): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const linhaId = url.searchParams.get("linha_id");
  if (linhaId === null || !isUuid(linhaId)) {
    throw new HttpError(400, "validation_error", "linha_id invalido (UUID esperado)");
  }

  const { data: linha, error: linhaError } = await db
    .from("produto_linhas")
    .select("id, nome")
    .eq("id", linhaId)
    .maybeSingle();
  if (linhaError) {
    throw new HttpError(500, "linha_query_failed", "falha ao consultar a Linha");
  }
  if (!linha) {
    throw new HttpError(404, "nao_encontrado", "Linha nao encontrada");
  }

  const [linhaAtributosRes, produtosRes] = await Promise.all([
    db
      .from("produto_linha_atributos")
      .select("chave, tipo, obrigatorio, mostra_catalogo, mostra_ficha")
      .eq("linha_id", linhaId)
      .order("chave", { ascending: true }),
    db
      .from("produtos")
      .select("id, nome, descricao, atributos, prazo_entrega, disponibilidade, pedido_minimo")
      .eq("linha_id", linhaId)
      .eq("ativo", true)
      .order("nome", { ascending: true }),
  ]);
  if (linhaAtributosRes.error) {
    throw new HttpError(500, "atributos_query_failed", "falha ao consultar o schema da Linha");
  }
  if (produtosRes.error) {
    throw new HttpError(500, "produtos_query_failed", "falha ao listar os produtos");
  }

  const atributos_linha = (linhaAtributosRes.data ?? []) as DocAtributo[];
  const produtos = (produtosRes.data ?? []) as Array<{
    id: string;
    nome: string;
    descricao: string | null;
    atributos: Record<string, unknown>;
    prazo_entrega: string | null;
    disponibilidade: string | null;
    pedido_minimo: string | null;
  }>;
  const produtoIds = produtos.map((p) => p.id);

  // Atributos proprios por Produto, SKUs por Produto e imagens (produto+SKU).
  const [produtoAtributos, skus] = await Promise.all([
    fetchAllByIn<DocAtributo & { produto_id: string }>(
      db,
      "produto_atributos",
      "produto_id, chave, tipo, obrigatorio, mostra_catalogo, mostra_ficha",
      "produto_id",
      produtoIds,
      "chave",
    ),
    fetchAllByIn<{
      id: string;
      produto_id: string;
      codigo_sku: string;
      tipo_origem: string;
      atributos: Record<string, unknown>;
      dimensoes: Record<string, unknown> | null;
      acabamento: string | null;
      peso_gr: number | null;
      tolerancia_pct: number | null;
    }>(
      db,
      "produto_skus",
      "id, produto_id, codigo_sku, tipo_origem, atributos, dimensoes, acabamento, peso_gr, tolerancia_pct",
      "produto_id",
      produtoIds,
      "codigo_sku",
    ),
  ]);
  const skuIds = skus.map((s) => s.id);

  const [imgProduto, imgSku] = await Promise.all([
    fetchAllByIn<{ produto_id: string | null; storage_path: string; ordem: number }>(
      db,
      "produto_imagens",
      "produto_id, storage_path, ordem",
      "produto_id",
      produtoIds,
      "ordem",
    ),
    fetchAllByIn<{ sku_id: string | null; storage_path: string; ordem: number }>(
      db,
      "produto_imagens",
      "sku_id, storage_path, ordem",
      "sku_id",
      skuIds,
      "ordem",
    ),
  ]);

  // Primeira foto (menor ordem) por Produto e por SKU.
  const pathPorProduto = new Map<string, string>();
  for (const r of imgProduto) {
    if (r.produto_id && !pathPorProduto.has(r.produto_id)) {
      pathPorProduto.set(r.produto_id, r.storage_path);
    }
  }
  const pathPorSku = new Map<string, string>();
  for (const r of imgSku) {
    if (r.sku_id && !pathPorSku.has(r.sku_id)) pathPorSku.set(r.sku_id, r.storage_path);
  }

  // Assina todas as paths necessarias em um unico lote.
  const todasPaths = [
    ...new Set<string>([...pathPorProduto.values(), ...pathPorSku.values()]),
  ];
  const urlPorPath = new Map<string, string>();
  if (todasPaths.length > 0) {
    const signed = await db.storage
      .from(PRODUTOS_BUCKET)
      .createSignedUrls(todasPaths, DOC_SIGNED_URL_TTL_SECONDS);
    if (signed.error) {
      throw new HttpError(500, "signed_url_failed", "falha ao gerar as URLs das imagens");
    }
    for (const s of signed.data ?? []) {
      if (s.path && s.signedUrl) urlPorPath.set(s.path, s.signedUrl);
    }
  }

  const atributosPorProduto = new Map<string, DocAtributo[]>();
  for (const a of produtoAtributos) {
    const list = atributosPorProduto.get(a.produto_id) ?? [];
    list.push(a);
    atributosPorProduto.set(a.produto_id, list);
  }
  const skusPorProduto = new Map<string, typeof skus>();
  for (const s of skus) {
    const list = skusPorProduto.get(s.produto_id) ?? [];
    list.push(s);
    skusPorProduto.set(s.produto_id, list);
  }

  const produtosOut = produtos.map((p) => {
    const pSkus = skusPorProduto.get(p.id) ?? [];
    // Foto do Produto: imagem propria; na falta, a 1a foto de SKU.
    let pathProduto = pathPorProduto.get(p.id);
    if (!pathProduto) {
      for (const s of pSkus) {
        const sp = pathPorSku.get(s.id);
        if (sp) {
          pathProduto = sp;
          break;
        }
      }
    }
    return {
      id: p.id,
      nome: p.nome,
      descricao: p.descricao,
      atributos: p.atributos ?? {},
      prazo_entrega: p.prazo_entrega,
      disponibilidade: p.disponibilidade,
      pedido_minimo: p.pedido_minimo,
      foto_url: pathProduto ? urlPorPath.get(pathProduto) ?? null : null,
      atributos_produto: atributosPorProduto.get(p.id) ?? [],
      skus: pSkus.map((s) => ({
        id: s.id,
        codigo_sku: s.codigo_sku,
        tipo_origem: s.tipo_origem,
        atributos: s.atributos ?? {},
        dimensoes: s.dimensoes,
        acabamento: s.acabamento,
        peso_gr: s.peso_gr,
        tolerancia_pct: s.tolerancia_pct,
        foto_url: (() => {
          const sp = pathPorSku.get(s.id);
          return sp ? urlPorPath.get(sp) ?? null : null;
        })(),
      })),
    };
  });

  return jsonResponse(
    { linha: { id: linha.id, nome: linha.nome }, atributos_linha, produtos: produtosOut },
    200,
  );
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

    // ----- /documentos-dados -----
    if (root === "documentos-dados" && segments.length === 1) {
      if (req.method === "GET") return await getDocumentosDados(req);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET");
    }

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

      // Sub-rota de atributos proprios: /produtos/:id/atributos[/:aid]
      if (segments[2] === "atributos") {
        const atributoIdRaw = segments[3];
        if (atributoIdRaw === undefined) {
          if (req.method === "GET") return await listProdutoAtributos(produtoId);
          if (req.method === "POST") return await createProdutoAtributo(req, produtoId, email);
          throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
        }
        const atributoId = assertUuid(atributoIdRaw, "atributo");
        if (segments.length > 4) {
          throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
        }
        if (req.method === "PUT") {
          return await updateProdutoAtributo(req, produtoId, atributoId, email);
        }
        if (req.method === "DELETE") {
          return await deleteProdutoAtributo(produtoId, atributoId, email);
        }
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use PUT ou DELETE");
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
