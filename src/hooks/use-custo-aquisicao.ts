"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createCustoAquisicao,
  deleteCustoAquisicao,
  getCustoAquisicaoVigente,
  listCustoAquisicaoHistorico,
  updateCustoAquisicao,
  type CustoAquisicaoInput,
} from "@/lib/api/insumos";
import { precoCalculadoKeys } from "@/hooks/use-precos-calculados";
import { precoPendenteKeys } from "@/hooks/use-precos-pendentes";

/** Chaves de cache do custo de aquisicao por SKU (vigente + historico). */
export const custoAquisicaoKeys = {
  all: ["sku-custo-aquisicao"] as QueryKey,
  vigente: (skuId: string): QueryKey => ["sku-custo-aquisicao", skuId, "vigente"],
  historico: (skuId: string): QueryKey => [
    "sku-custo-aquisicao",
    skuId,
    "historico",
  ],
};

/** useCustoAquisicaoVigente — faixa de custo vigente de um SKU comprado (ou null). */
export function useCustoAquisicaoVigente(
  skuId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: custoAquisicaoKeys.vigente(skuId ?? ""),
    queryFn: () => getCustoAquisicaoVigente(skuId as string),
    enabled: (options?.enabled ?? true) && Boolean(skuId),
  });
}

/** useCustoAquisicaoHistorico — historico completo de custo de aquisicao do SKU. */
export function useCustoAquisicaoHistorico(
  skuId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: custoAquisicaoKeys.historico(skuId ?? ""),
    queryFn: () => listCustoAquisicaoHistorico(skuId as string),
    enabled: (options?.enabled ?? true) && Boolean(skuId),
  });
}

/** Invalida o custo de aquisicao do SKU + o grid de precos + a fila de pendentes. */
function invalidateCustoEPrecos(
  queryClient: ReturnType<typeof useQueryClient>,
  skuId: string,
) {
  queryClient.invalidateQueries({ queryKey: custoAquisicaoKeys.vigente(skuId) });
  queryClient.invalidateQueries({
    queryKey: custoAquisicaoKeys.historico(skuId),
  });
  queryClient.invalidateQueries({ queryKey: precoCalculadoKeys.bySku(skuId) });
  queryClient.invalidateQueries({ queryKey: precoPendenteKeys.all });
}

/** useCreateCustoAquisicao — registra faixa de custo (POST). Dispara recalculo do SKU. */
export function useCreateCustoAquisicao() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      skuId,
      input,
    }: {
      skuId: string;
      input: CustoAquisicaoInput;
    }) => createCustoAquisicao(skuId, input),
    onSuccess: (_data, variables) =>
      invalidateCustoEPrecos(queryClient, variables.skuId),
  });
}

/** useUpdateCustoAquisicao — edita faixa de custo (PUT /custo-aquisicao/:id). */
export function useUpdateCustoAquisicao() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      skuId: string;
      input: Partial<CustoAquisicaoInput>;
    }) => updateCustoAquisicao(id, input),
    onSuccess: (_data, variables) =>
      invalidateCustoEPrecos(queryClient, variables.skuId),
  });
}

/** useDeleteCustoAquisicao — remove faixa de custo (DELETE /custo-aquisicao/:id). */
export function useDeleteCustoAquisicao() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; skuId: string }) =>
      deleteCustoAquisicao(id),
    onSuccess: (_data, variables) =>
      invalidateCustoEPrecos(queryClient, variables.skuId),
  });
}
