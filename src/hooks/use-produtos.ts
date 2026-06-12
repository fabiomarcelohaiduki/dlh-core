"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createProduto,
  deleteProduto,
  listProdutos,
  updateProduto,
  type ListProdutosParams,
  type ProdutoInput,
} from "@/lib/api/produtos";

/** Chaves de cache de produtos (lista + detalhe agregado). */
export const produtoKeys = {
  all: ["produtos"] as QueryKey,
  list: (params: ListProdutosParams): QueryKey => ["produtos", "list", params],
  detail: (id: string): QueryKey => ["produtos", "detail", id],
};

/** useProdutos — lista paginada de produtos (GET /produtos), filtravel por linha. */
export function useProdutos(params: ListProdutosParams = {}) {
  return useQuery({
    queryKey: produtoKeys.list(params),
    queryFn: () => listProdutos(params),
  });
}

/** useCreateProduto — cria produto (POST /produtos). Invalida a lista. */
export function useCreateProduto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProdutoInput) => createProduto(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: produtoKeys.all });
    },
  });
}

/** useUpdateProduto — atualiza produto (PUT /produtos/:id). Invalida lista e detalhe. */
export function useUpdateProduto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<ProdutoInput> }) =>
      updateProduto(id, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: produtoKeys.all });
      queryClient.invalidateQueries({
        queryKey: produtoKeys.detail(variables.id),
      });
    },
  });
}

/** useDeleteProduto — remove produto (DELETE /produtos/:id). Invalida a lista. */
export function useDeleteProduto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProduto(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: produtoKeys.all });
    },
  });
}
