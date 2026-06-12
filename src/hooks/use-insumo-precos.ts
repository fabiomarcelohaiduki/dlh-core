"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createInsumoPreco,
  listInsumoPrecos,
  updateInsumoPrecosBatch,
  type InsumoPrecoBatchItem,
  type InsumoPrecoInput,
} from "@/lib/api/insumos";
import { precoPendenteKeys } from "@/hooks/use-precos-pendentes";

/** Chaves de cache dos precos de fornecedor por insumo. */
export const insumoPrecoKeys = {
  all: ["insumo-precos"] as QueryKey,
  byInsumo: (insumoId: string): QueryKey => ["insumo-precos", insumoId],
};

/** useInsumoPrecos — faixas de preco de um insumo (GET /insumos/:id/precos). */
export function useInsumoPrecos(
  insumoId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: insumoPrecoKeys.byInsumo(insumoId ?? ""),
    queryFn: () => listInsumoPrecos(insumoId as string),
    enabled: (options?.enabled ?? true) && Boolean(insumoId),
  });
}

/**
 * useCreateInsumoPreco — adiciona faixa de preco (POST). Invalida os precos do
 * insumo e a fila de pendentes (o backend marca SKUs afetados para recalculo).
 */
export function useCreateInsumoPreco() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      insumoId,
      input,
    }: {
      insumoId: string;
      input: InsumoPrecoInput;
    }) => createInsumoPreco(insumoId, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: insumoPrecoKeys.byInsumo(variables.insumoId),
      });
      queryClient.invalidateQueries({ queryKey: precoPendenteKeys.all });
    },
  });
}

/**
 * useUpdateInsumoPrecosBatch — edicao em lote de precos (PUT /insumo-precos/batch).
 * Invalida todos os precos de insumo e a fila de pendentes.
 */
export function useUpdateInsumoPrecosBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itens: InsumoPrecoBatchItem[]) =>
      updateInsumoPrecosBatch(itens),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: insumoPrecoKeys.all });
      queryClient.invalidateQueries({ queryKey: precoPendenteKeys.all });
    },
  });
}
