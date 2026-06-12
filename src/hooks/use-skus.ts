"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createSku,
  deleteSku,
  getSku,
  updateSku,
  type SkuInput,
} from "@/lib/api/produtos";
import { produtoKeys } from "@/hooks/use-produtos";

/** Chaves de cache dos SKUs (detalhe individual). */
export const skuKeys = {
  all: ["skus"] as QueryKey,
  detail: (skuId: string): QueryKey => ["skus", skuId],
};

/** useSku — detalhe de um SKU (GET /skus/:skuId). */
export function useSku(
  skuId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: skuKeys.detail(skuId ?? ""),
    queryFn: () => getSku(skuId as string),
    enabled: (options?.enabled ?? true) && Boolean(skuId),
  });
}

/** useCreateSku — cria SKU em um produto (POST /produtos/:id/skus). Invalida o detalhe do produto. */
export function useCreateSku() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ produtoId, input }: { produtoId: string; input: SkuInput }) =>
      createSku(produtoId, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: produtoKeys.detail(variables.produtoId),
      });
    },
  });
}

/** useUpdateSku — atualiza SKU (PUT /skus/:skuId). Invalida o SKU e os detalhes de produto. */
export function useUpdateSku() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ skuId, input }: { skuId: string; input: Partial<SkuInput> }) =>
      updateSku(skuId, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: skuKeys.detail(variables.skuId) });
      queryClient.invalidateQueries({ queryKey: produtoKeys.all });
    },
  });
}

/** useDeleteSku — remove SKU (DELETE /skus/:skuId). Invalida o SKU e os detalhes de produto. */
export function useDeleteSku() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skuId: string) => deleteSku(skuId),
    onSuccess: (_data, skuId) => {
      queryClient.invalidateQueries({ queryKey: skuKeys.detail(skuId) });
      queryClient.invalidateQueries({ queryKey: produtoKeys.all });
    },
  });
}
