"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createClienteRevenda,
  createRevendaPreco,
  deleteRevendaPreco,
  getClienteRevenda,
  listClientesRevenda,
  listRevendaPrecos,
  updateClienteRevenda,
  updateRevendaPreco,
  type ClienteRevendaInput,
  type ListClientesParams,
  type ListRevendaPrecosParams,
  type RevendaPrecoInput,
} from "@/lib/api/revenda";

/** Chaves de cache da revenda (clientes + precos por cliente/SKU). */
export const clienteRevendaKeys = {
  all: ["clientes-revenda"] as QueryKey,
  list: (params: ListClientesParams): QueryKey => [
    "clientes-revenda",
    "list",
    params,
  ],
  detail: (id: string): QueryKey => ["clientes-revenda", "detail", id],
};

export const revendaPrecoKeys = {
  all: ["revenda-precos"] as QueryKey,
  byCliente: (clienteId: string, params: ListRevendaPrecosParams): QueryKey => [
    "revenda-precos",
    clienteId,
    params,
  ],
};

// --- Clientes de revenda -------------------------------------------

/** useClientesRevenda — lista paginada de clientes de revenda. */
export function useClientesRevenda(params: ListClientesParams = {}) {
  return useQuery({
    queryKey: clienteRevendaKeys.list(params),
    queryFn: () => listClientesRevenda(params),
  });
}

/** useClienteRevenda — detalhe de um cliente de revenda (GET /:id). */
export function useClienteRevenda(
  id: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: clienteRevendaKeys.detail(id ?? ""),
    queryFn: () => getClienteRevenda(id as string),
    enabled: (options?.enabled ?? true) && Boolean(id),
  });
}

/** useCreateClienteRevenda — cria cliente (POST). Invalida a lista de clientes. */
export function useCreateClienteRevenda() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ClienteRevendaInput) => createClienteRevenda(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clienteRevendaKeys.all });
    },
  });
}

/** useUpdateClienteRevenda — edita cliente (PUT /:id). Invalida lista e detalhe. */
export function useUpdateClienteRevenda() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Partial<ClienteRevendaInput>;
    }) => updateClienteRevenda(id, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: clienteRevendaKeys.all });
      queryClient.invalidateQueries({
        queryKey: clienteRevendaKeys.detail(variables.id),
      });
    },
  });
}

// --- Precos de revenda ---------------------------------------------

/** useRevendaPrecos — precos de revenda de um cliente (vigentes ou ?historico=). */
export function useRevendaPrecos(
  clienteId: string | undefined,
  params: ListRevendaPrecosParams = {},
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: revendaPrecoKeys.byCliente(clienteId ?? "", params),
    queryFn: () => listRevendaPrecos(clienteId as string, params),
    enabled: (options?.enabled ?? true) && Boolean(clienteId),
  });
}

/** useCreateRevendaPreco — adiciona faixa de preco (POST). Invalida os precos. */
export function useCreateRevendaPreco() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      clienteId,
      input,
    }: {
      clienteId: string;
      input: RevendaPrecoInput;
    }) => createRevendaPreco(clienteId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: revendaPrecoKeys.all });
    },
  });
}

/** useUpdateRevendaPreco — edita faixa de preco (PUT /revenda-precos/:id). */
export function useUpdateRevendaPreco() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Partial<Omit<RevendaPrecoInput, "sku_id">>;
    }) => updateRevendaPreco(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: revendaPrecoKeys.all });
    },
  });
}

/** useDeleteRevendaPreco — remove faixa de preco (DELETE /revenda-precos/:id). */
export function useDeleteRevendaPreco() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRevendaPreco(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: revendaPrecoKeys.all });
    },
  });
}
