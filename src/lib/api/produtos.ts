import { apiFetch, buildQuery } from "@/lib/api/client";
import type {
  AtributoTipo,
  LinhaAtributo,
  Paginated,
  Produto,
  ProdutoAtributo,
  ProdutoDetalhe,
  ProdutoImagem,
  ProdutoLinha,
  ProdutoSku,
  SkuTipoOrigem,
  SkuUnidadeTempo,
} from "@/lib/api/types";

// ---------------------------------------------------------------------
// Dominio A — Linhas, Atributos, Produtos, SKUs e Imagens.
// As Edge Functions respondem em snake_case e o frontend preserva esse
// formato (sem mapeamento snake -> camel); por isso os modulos apenas
// encaminham os payloads tipados via apiFetch.
// ---------------------------------------------------------------------

/** Filtros da listagem de Linhas (produtos-linhas). */
export interface ListLinhasParams {
  ativo?: boolean;
  limit?: number;
  offset?: number;
}

// --- Linhas ---------------------------------------------------------

export function listLinhas(
  params: ListLinhasParams = {},
): Promise<Paginated<ProdutoLinha>> {
  return apiFetch<Paginated<ProdutoLinha>>(
    `produtos-linhas${buildQuery(params)}`,
    { method: "GET" },
  );
}

export interface LinhaInput {
  nome: string;
  descricao?: string | null;
  ativo?: boolean;
}

export function createLinha(input: LinhaInput): Promise<ProdutoLinha> {
  return apiFetch<ProdutoLinha>("produtos-linhas", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateLinha(
  id: string,
  input: Partial<LinhaInput>,
): Promise<ProdutoLinha> {
  return apiFetch<ProdutoLinha>(`produtos-linhas/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteLinha(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`produtos-linhas/${id}`, {
    method: "DELETE",
  });
}

// --- Atributos de Linha --------------------------------------------

export function listLinhaAtributos(
  linhaId: string,
): Promise<Paginated<LinhaAtributo>> {
  return apiFetch<Paginated<LinhaAtributo>>(
    `produtos-linhas/${linhaId}/atributos`,
    { method: "GET" },
  );
}

export interface LinhaAtributoInput {
  chave: string;
  tipo: AtributoTipo;
  obrigatorio?: boolean;
}

export function createLinhaAtributo(
  linhaId: string,
  input: LinhaAtributoInput,
): Promise<LinhaAtributo> {
  return apiFetch<LinhaAtributo>(`produtos-linhas/${linhaId}/atributos`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateLinhaAtributo(
  linhaId: string,
  atributoId: string,
  input: Partial<LinhaAtributoInput>,
): Promise<LinhaAtributo> {
  return apiFetch<LinhaAtributo>(
    `produtos-linhas/${linhaId}/atributos/${atributoId}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function deleteLinhaAtributo(
  linhaId: string,
  atributoId: string,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `produtos-linhas/${linhaId}/atributos/${atributoId}`,
    { method: "DELETE" },
  );
}

// --- Produtos -------------------------------------------------------

/** Filtros da listagem de Produtos (produtos-catalogo/produtos). */
export interface ListProdutosParams {
  linha_id?: string;
  ativo?: boolean;
  limit?: number;
  offset?: number;
}

export function listProdutos(
  params: ListProdutosParams = {},
): Promise<Paginated<Produto>> {
  return apiFetch<Paginated<Produto>>(
    `produtos-catalogo/produtos${buildQuery(params)}`,
    { method: "GET" },
  );
}

export function getProduto(id: string): Promise<ProdutoDetalhe> {
  return apiFetch<ProdutoDetalhe>(`produtos-catalogo/produtos/${id}`, {
    method: "GET",
  });
}

export interface ProdutoInput {
  linha_id: string;
  nome: string;
  descricao?: string | null;
  atributos?: Record<string, unknown>;
  prazo_entrega?: string | null;
  disponibilidade?: string | null;
  pedido_minimo?: string | null;
  ativo?: boolean;
}

export function createProduto(input: ProdutoInput): Promise<Produto> {
  return apiFetch<Produto>("produtos-catalogo/produtos", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateProduto(
  id: string,
  input: Partial<ProdutoInput>,
): Promise<Produto> {
  return apiFetch<Produto>(`produtos-catalogo/produtos/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteProduto(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`produtos-catalogo/produtos/${id}`, {
    method: "DELETE",
  });
}

// --- Atributos proprios do Produto ---------------------------------

export function listProdutoAtributos(
  produtoId: string,
): Promise<{ items: ProdutoAtributo[] }> {
  return apiFetch<{ items: ProdutoAtributo[] }>(
    `produtos-catalogo/produtos/${produtoId}/atributos`,
    { method: "GET" },
  );
}

export interface ProdutoAtributoInput {
  chave: string;
  tipo: AtributoTipo;
  obrigatorio?: boolean;
}

export function createProdutoAtributo(
  produtoId: string,
  input: ProdutoAtributoInput,
): Promise<ProdutoAtributo> {
  return apiFetch<ProdutoAtributo>(
    `produtos-catalogo/produtos/${produtoId}/atributos`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function deleteProdutoAtributo(
  produtoId: string,
  atributoId: string,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `produtos-catalogo/produtos/${produtoId}/atributos/${atributoId}`,
    { method: "DELETE" },
  );
}

// --- SKUs -----------------------------------------------------------

export interface SkuInput {
  codigo_sku: string;
  tipo_origem: SkuTipoOrigem;
  atributos?: Record<string, unknown>;
  dimensoes?: Record<string, unknown> | null;
  tolerancia_pct?: number | null;
  acabamento?: string | null;
  peso_gr?: number | null;
  diretriz_producao?: string | null;
  /** Lote de producao (so fabricado); tempo_producao e derivado no backend. */
  tamanho_lote?: number | null;
  tempo_lote?: number | null;
  unidade_tempo?: SkuUnidadeTempo | null;
  ativo?: boolean;
}

export function createSku(
  produtoId: string,
  input: SkuInput,
): Promise<ProdutoSku> {
  return apiFetch<ProdutoSku>(`produtos-catalogo/produtos/${produtoId}/skus`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getSku(skuId: string): Promise<ProdutoSku> {
  return apiFetch<ProdutoSku>(`produtos-catalogo/skus/${skuId}`, {
    method: "GET",
  });
}

export function updateSku(
  skuId: string,
  input: Partial<SkuInput>,
): Promise<ProdutoSku> {
  return apiFetch<ProdutoSku>(`produtos-catalogo/skus/${skuId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteSku(skuId: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`produtos-catalogo/skus/${skuId}`, {
    method: "DELETE",
  });
}

// --- Imagens (produtos-imagens) ------------------------------------

/** Filtros da listagem de imagens (por produto e/ou por SKU). */
export interface ListImagensParams {
  produto_id?: string;
  sku_id?: string;
}

export function listImagens(
  params: ListImagensParams = {},
): Promise<{ items: ProdutoImagem[] }> {
  return apiFetch<{ items: ProdutoImagem[] }>(
    `produtos-imagens${buildQuery(params)}`,
    { method: "GET" },
  );
}

/** Upload de foto via multipart/form-data (campos: file, produto_id?, sku_id?, ordem?, legenda?). */
export interface UploadImagemInput {
  file: File;
  produto_id?: string;
  sku_id?: string;
  ordem?: number;
  legenda?: string;
}

export function uploadImagem(
  input: UploadImagemInput,
): Promise<ProdutoImagem> {
  const form = new FormData();
  form.append("file", input.file);
  if (input.produto_id) form.append("produto_id", input.produto_id);
  if (input.sku_id) form.append("sku_id", input.sku_id);
  if (input.ordem !== undefined) form.append("ordem", String(input.ordem));
  if (input.legenda !== undefined) form.append("legenda", input.legenda);
  return apiFetch<ProdutoImagem>("produtos-imagens", {
    method: "POST",
    body: form,
  });
}

export function deleteImagem(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`produtos-imagens/${id}`, {
    method: "DELETE",
  });
}
