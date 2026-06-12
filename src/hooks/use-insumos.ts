"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createInsumo,
  deleteInsumo,
  listInsumos,
  updateInsumo,
  type InsumoInput,
  type ListInsumosParams,
} from "@/lib/api/insumos";

/** Chaves de cache dos insumos. */
export const insumoKeys = {
  all: ["insumos"] as QueryKey,
  list: (params: ListInsumosParams): QueryKey => ["insumos", "list", params],
};

/** useInsumos — lista paginada de insumos (GET /insumos). */
export function useInsumos(params: ListInsumosParams = {}) {
  return useQuery({
    queryKey: insumoKeys.list(params),
    queryFn: () => listInsumos(params),
  });
}

/** useCreateInsumo — cria insumo (POST). Invalida a lista de insumos. */
export function useCreateInsumo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InsumoInput) => createInsumo(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: insumoKeys.all });
    },
  });
}

/** useUpdateInsumo — atualiza insumo (PUT /:id). Invalida a lista de insumos. */
export function useUpdateInsumo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<InsumoInput> }) =>
      updateInsumo(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: insumoKeys.all });
    },
  });
}

/** useDeleteInsumo — remove insumo (DELETE /:id). Invalida a lista de insumos. */
export function useDeleteInsumo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteInsumo(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: insumoKeys.all });
    },
  });
}
