"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createRegra,
  deleteRegra,
  listRegras,
  updateRegra,
  type CreateRegraInput,
  type UpdateRegraInput,
} from "@/lib/api/automacao";

/** Chaves de cache das regras duras (aba Regras). */
export const regraKeys = {
  all: ["triagem-regras"] as QueryKey,
  list: (): QueryKey => ["triagem-regras", "list"],
};

/** useTriagemRegras — lista as regras duras (GET automacao-regras). */
export function useTriagemRegras() {
  return useQuery({
    queryKey: regraKeys.list(),
    queryFn: () => listRegras(),
  });
}

/** useCreateRegra — cria regra dura (POST). Invalida a lista no onSuccess. */
export function useCreateRegra() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRegraInput) => createRegra(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: regraKeys.all });
    },
  });
}

/** useUpdateRegra — atualiza termo/ativo (PUT). Invalida a lista no onSuccess. */
export function useUpdateRegra() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateRegraInput) => updateRegra(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: regraKeys.all });
    },
  });
}

/** useDeleteRegra — remove regra (DELETE). Invalida a lista no onSuccess. */
export function useDeleteRegra() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRegra(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: regraKeys.all });
    },
  });
}
