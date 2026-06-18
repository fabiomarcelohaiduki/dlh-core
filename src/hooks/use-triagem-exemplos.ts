"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  deleteExemplo,
  listExemplos,
  toggleExemplo,
  type ListExemplosParams,
} from "@/lib/api/automacao";

/** Chaves de cache do acervo few-shot (aba Aprendizado, E14). */
export const exemploKeys = {
  all: ["triagem-exemplos"] as QueryKey,
  list: (params: ListExemplosParams): QueryKey => [
    "triagem-exemplos",
    "list",
    params,
  ],
};

/**
 * useTriagemExemplos — lista o acervo few-shot (GET automacao-exemplos),
 * filtravel por veredito/ativo.
 */
export function useTriagemExemplos(params: ListExemplosParams = {}) {
  return useQuery({
    queryKey: exemploKeys.list(params),
    queryFn: () => listExemplos(params),
  });
}

/**
 * useToggleExemplo — alterna `ativo` de um exemplo (PATCH, soft-delete
 * reversivel). Invalida o acervo no onSuccess.
 */
export function useToggleExemplo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ativo }: { id: string; ativo: boolean }) =>
      toggleExemplo(id, ativo),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: exemploKeys.all });
    },
  });
}

/**
 * useDeleteExemplo — remove fisicamente um exemplo (DELETE). Invalida o acervo
 * no onSuccess.
 */
export function useDeleteExemplo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteExemplo(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: exemploKeys.all });
    },
  });
}
