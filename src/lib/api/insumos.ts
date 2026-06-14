import { apiFetch, buildQuery } from "@/lib/api/client";
import type {
  Insumo,
  InsumoCategoria,
  InsumoPreco,
  InsumoPrecoBatchResponse,
  Paginated,
  SkuComposicaoItem,
  SkuCustoAquisicao,
} from "@/lib/api/types";

// ---------------------------------------------------------------------
// Dominio B — Insumos, precos de fornecedor, composicao (BOM) e custo
// de aquisicao. As escritas disparam recalculo SINCRONO dos SKUs no
// backend (triggers); cabe a UI invalidar os caches de precos.
// Respostas e payloads permanecem em snake_case no frontend.
// ---------------------------------------------------------------------

// --- Insumos --------------------------------------------------------

/** Filtros da listagem de insumos (insumos). */
export interface ListInsumosParams {
  ativo?: boolean;
  limit?: number;
  offset?: number;
}

export function listInsumos(
  params: ListInsumosParams = {},
): Promise<Paginated<Insumo>> {
  return apiFetch<Paginated<Insumo>>(`produtos-insumos/insumos${buildQuery(params)}`, {
    method: "GET",
  });
}

export interface InsumoInput {
  nome: string;
  categoria: InsumoCategoria;
  unidade: string;
  ativo?: boolean;
}

export function createInsumo(input: InsumoInput): Promise<Insumo> {
  return apiFetch<Insumo>("produtos-insumos/insumos", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateInsumo(
  id: string,
  input: Partial<InsumoInput>,
): Promise<Insumo> {
  return apiFetch<Insumo>(`produtos-insumos/insumos/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteInsumo(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`produtos-insumos/insumos/${id}`, {
    method: "DELETE",
  });
}

// --- Precos de fornecedor do insumo --------------------------------

export function listInsumoPrecos(
  insumoId: string,
): Promise<{ items: InsumoPreco[] }> {
  return apiFetch<{ items: InsumoPreco[] }>(
    `produtos-insumos/insumos/${insumoId}/precos`,
    { method: "GET" },
  );
}

export interface InsumoPrecoInput {
  fornecedor?: string | null;
  preco: number;
  vigencia_inicio: string;
  vigencia_fim?: string | null;
}

export function createInsumoPreco(
  insumoId: string,
  input: InsumoPrecoInput,
): Promise<InsumoPreco> {
  return apiFetch<InsumoPreco>(`produtos-insumos/insumos/${insumoId}/precos`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteInsumoPreco(
  insumoId: string,
  precoId: string,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `produtos-insumos/insumos/${insumoId}/precos/${precoId}`,
    { method: "DELETE" },
  );
}

/** Item da edicao em lote de precos (PUT /insumo-precos/batch). */
export interface InsumoPrecoBatchItem {
  id: string;
  preco: number;
}

export function updateInsumoPrecosBatch(
  itens: InsumoPrecoBatchItem[],
): Promise<InsumoPrecoBatchResponse> {
  return apiFetch<InsumoPrecoBatchResponse>("produtos-insumos/insumo-precos/batch", {
    method: "PUT",
    body: JSON.stringify({ itens }),
  });
}

// --- Composicao (BOM) do SKU ---------------------------------------

export function listComposicao(
  skuId: string,
): Promise<{ items: SkuComposicaoItem[] }> {
  return apiFetch<{ items: SkuComposicaoItem[] }>(
    `produtos-composicao/skus/${skuId}/composicao`,
    { method: "GET" },
  );
}

export interface ComposicaoItemInput {
  insumo_id: string;
  quantidade: number;
  unidade?: string | null;
}

export function createComposicaoItem(
  skuId: string,
  input: ComposicaoItemInput,
): Promise<SkuComposicaoItem> {
  return apiFetch<SkuComposicaoItem>(
    `produtos-composicao/skus/${skuId}/composicao`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function updateComposicaoItem(
  id: string,
  input: Partial<ComposicaoItemInput>,
): Promise<SkuComposicaoItem> {
  return apiFetch<SkuComposicaoItem>(`produtos-composicao/composicao/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteComposicaoItem(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`produtos-composicao/composicao/${id}`, {
    method: "DELETE",
  });
}

// --- Custo de aquisicao (SKUs comprados) ---------------------------

/**
 * GET /skus/:skuId/custo-aquisicao — retorna a faixa vigente (linha unica ou
 * null). Com ?historico=true devolve o historico completo em { items }.
 */
export function getCustoAquisicaoVigente(
  skuId: string,
): Promise<SkuCustoAquisicao | null> {
  return apiFetch<SkuCustoAquisicao | null>(
    `produtos-composicao/skus/${skuId}/custo-aquisicao`,
    { method: "GET" },
  );
}

export function listCustoAquisicaoHistorico(
  skuId: string,
): Promise<{ items: SkuCustoAquisicao[] }> {
  return apiFetch<{ items: SkuCustoAquisicao[] }>(
    `produtos-composicao/skus/${skuId}/custo-aquisicao${buildQuery({ historico: true })}`,
    { method: "GET" },
  );
}

export interface CustoAquisicaoInput {
  fornecedor?: string | null;
  custo: number;
  vigencia_inicio: string;
  vigencia_fim?: string | null;
}

export function createCustoAquisicao(
  skuId: string,
  input: CustoAquisicaoInput,
): Promise<SkuCustoAquisicao> {
  return apiFetch<SkuCustoAquisicao>(
    `produtos-composicao/skus/${skuId}/custo-aquisicao`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function updateCustoAquisicao(
  id: string,
  input: Partial<CustoAquisicaoInput>,
): Promise<SkuCustoAquisicao> {
  return apiFetch<SkuCustoAquisicao>(
    `produtos-composicao/custo-aquisicao/${id}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function deleteCustoAquisicao(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `produtos-composicao/custo-aquisicao/${id}`,
    { method: "DELETE" },
  );
}
