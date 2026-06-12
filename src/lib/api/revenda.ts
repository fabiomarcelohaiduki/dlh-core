import { apiFetch, buildQuery } from "@/lib/api/client";
import type {
  ClienteRevenda,
  Paginated,
  RevendaPreco,
} from "@/lib/api/types";

// ---------------------------------------------------------------------
// Dominio D — Revenda (canal SEPARADO do de licitacao): clientes de
// revenda e suas faixas de preco por SKU, com vigencia.
// Respostas e payloads permanecem em snake_case no frontend.
// ---------------------------------------------------------------------

// --- Clientes de revenda -------------------------------------------

/** Filtros da listagem de clientes de revenda. */
export interface ListClientesParams {
  ativo?: boolean;
  limit?: number;
  offset?: number;
}

export function listClientesRevenda(
  params: ListClientesParams = {},
): Promise<Paginated<ClienteRevenda>> {
  return apiFetch<Paginated<ClienteRevenda>>(
    `produtos-revenda/clientes-revenda${buildQuery(params)}`,
    { method: "GET" },
  );
}

export function getClienteRevenda(id: string): Promise<ClienteRevenda> {
  return apiFetch<ClienteRevenda>(`produtos-revenda/clientes-revenda/${id}`, {
    method: "GET",
  });
}

export interface ClienteRevendaInput {
  nome: string;
  ativo?: boolean;
}

export function createClienteRevenda(
  input: ClienteRevendaInput,
): Promise<ClienteRevenda> {
  return apiFetch<ClienteRevenda>("produtos-revenda/clientes-revenda", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** clientes-revenda so aceita GET/PUT (sem DELETE) — clientes nao sao removidos. */
export function updateClienteRevenda(
  id: string,
  input: Partial<ClienteRevendaInput>,
): Promise<ClienteRevenda> {
  return apiFetch<ClienteRevenda>(`produtos-revenda/clientes-revenda/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

// --- Precos de revenda por cliente/SKU -----------------------------

/** Filtros da leitura de precos de revenda de um cliente. */
export interface ListRevendaPrecosParams {
  sku_id?: string;
  historico?: boolean;
}

export function listRevendaPrecos(
  clienteId: string,
  params: ListRevendaPrecosParams = {},
): Promise<{ items: RevendaPreco[] }> {
  return apiFetch<{ items: RevendaPreco[] }>(
    `produtos-revenda/clientes-revenda/${clienteId}/precos${buildQuery(params)}`,
    { method: "GET" },
  );
}

export interface RevendaPrecoInput {
  sku_id: string;
  preco: number;
  vigencia_inicio: string;
  vigencia_fim?: string | null;
}

export function createRevendaPreco(
  clienteId: string,
  input: RevendaPrecoInput,
): Promise<RevendaPreco> {
  return apiFetch<RevendaPreco>(
    `produtos-revenda/clientes-revenda/${clienteId}/precos`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function updateRevendaPreco(
  id: string,
  input: Partial<Omit<RevendaPrecoInput, "sku_id">>,
): Promise<RevendaPreco> {
  return apiFetch<RevendaPreco>(`produtos-revenda/revenda-precos/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteRevendaPreco(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`produtos-revenda/revenda-precos/${id}`, {
    method: "DELETE",
  });
}
