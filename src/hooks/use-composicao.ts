"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createComposicaoItem,
  deleteComposicaoItem,
  listComposicao,
  updateComposicaoItem,
  type ComposicaoItemInput,
} from "@/lib/api/insumos";
import { precoCalculadoKeys } from "@/hooks/use-precos-calculados";
import { precoPendenteKeys } from "@/hooks/use-precos-pendentes";

/** Chaves de cache da composicao (BOM) por SKU. */
export const composicaoKeys = {
  all: ["sku-composicao"] as QueryKey,
  bySku: (skuId: string): QueryKey => ["sku-composicao", skuId],
};

/** useComposicao — itens da BOM de um SKU fabricado (GET /skus/:skuId/composicao). */
export function useComposicao(
  skuId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: composicaoKeys.bySku(skuId ?? ""),
    queryFn: () => listComposicao(skuId as string),
    enabled: (options?.enabled ?? true) && Boolean(skuId),
  });
}

/** Invalida a composicao do SKU + o grid de precos do SKU + a fila de pendentes. */
function invalidateComposicaoEPrecos(
  queryClient: ReturnType<typeof useQueryClient>,
  skuId: string,
) {
  queryClient.invalidateQueries({ queryKey: composicaoKeys.bySku(skuId) });
  queryClient.invalidateQueries({ queryKey: precoCalculadoKeys.bySku(skuId) });
  queryClient.invalidateQueries({ queryKey: precoPendenteKeys.all });
}

/**
 * useCreateComposicaoItem — adiciona item a BOM (POST). Invalida a composicao e
 * os precos (o backend dispara recalculo do SKU).
 */
export function useCreateComposicaoItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      skuId,
      input,
    }: {
      skuId: string;
      input: ComposicaoItemInput;
    }) => createComposicaoItem(skuId, input),
    onSuccess: (_data, variables) =>
      invalidateComposicaoEPrecos(queryClient, variables.skuId),
  });
}

/** useUpdateComposicaoItem — edita item da BOM (PUT /composicao/:id). */
export function useUpdateComposicaoItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      skuId: string;
      input: Partial<ComposicaoItemInput>;
    }) => updateComposicaoItem(id, input),
    onSuccess: (_data, variables) =>
      invalidateComposicaoEPrecos(queryClient, variables.skuId),
  });
}

/** useDeleteComposicaoItem — remove item da BOM (DELETE /composicao/:id). */
export function useDeleteComposicaoItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; skuId: string }) =>
      deleteComposicaoItem(id),
    onSuccess: (_data, variables) =>
      invalidateComposicaoEPrecos(queryClient, variables.skuId),
  });
}
