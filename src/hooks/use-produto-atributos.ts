"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createProdutoAtributo,
  deleteProdutoAtributo,
  listProdutoAtributos,
  updateProdutoAtributo,
  type ProdutoAtributoInput,
} from "@/lib/api/produtos";
import { produtoKeys } from "@/hooks/use-produtos";

/** Chaves de cache dos atributos proprios de um produto. */
export const produtoAtributoKeys = {
  all: ["produto-atributos"] as QueryKey,
  byProduto: (produtoId: string): QueryKey => ["produto-atributos", produtoId],
};

/** useProdutoAtributos — atributos proprios de um produto (GET /:id/atributos). */
export function useProdutoAtributos(
  produtoId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: produtoAtributoKeys.byProduto(produtoId ?? ""),
    queryFn: () => listProdutoAtributos(produtoId as string),
    enabled: (options?.enabled ?? true) && Boolean(produtoId),
  });
}

/**
 * useCreateProdutoAtributo — adiciona atributo proprio ao produto. Invalida os
 * atributos do produto e o detalhe (atributos_schema efetivo).
 */
export function useCreateProdutoAtributo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      produtoId,
      input,
    }: {
      produtoId: string;
      input: ProdutoAtributoInput;
    }) => createProdutoAtributo(produtoId, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: produtoAtributoKeys.byProduto(variables.produtoId),
      });
      queryClient.invalidateQueries({
        queryKey: produtoKeys.detail(variables.produtoId),
      });
    },
  });
}

/**
 * useUpdateProdutoAtributo — edita atributo proprio do produto. Invalida os
 * atributos do produto e o detalhe (atributos_schema efetivo).
 */
export function useUpdateProdutoAtributo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      produtoId,
      atributoId,
      input,
    }: {
      produtoId: string;
      atributoId: string;
      input: Partial<ProdutoAtributoInput>;
    }) => updateProdutoAtributo(produtoId, atributoId, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: produtoAtributoKeys.byProduto(variables.produtoId),
      });
      queryClient.invalidateQueries({
        queryKey: produtoKeys.detail(variables.produtoId),
      });
    },
  });
}

/**
 * useDeleteProdutoAtributo — remove atributo proprio do produto. Invalida os
 * atributos do produto e o detalhe (atributos_schema efetivo).
 */
export function useDeleteProdutoAtributo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      produtoId,
      atributoId,
    }: {
      produtoId: string;
      atributoId: string;
    }) => deleteProdutoAtributo(produtoId, atributoId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: produtoAtributoKeys.byProduto(variables.produtoId),
      });
      queryClient.invalidateQueries({
        queryKey: produtoKeys.detail(variables.produtoId),
      });
    },
  });
}
