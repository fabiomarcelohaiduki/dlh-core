"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createRelacionamentosRegra,
  deleteRelacionamentosRegra,
  getRelacionamentosRegra,
  listRelacionamentosRegras,
  toggleRelacionamentosRegra,
  updateRelacionamentosRegra,
} from "@/lib/api/relacionamentos-regras";
import type {
  ListRelacionamentosRegrasParams,
  RegraCreateInput,
  RegraUpdateInput,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Chaves de cache do catalogo de regras (factory).
// Padrao: `all` (invalida tudo) + `lists` + `details` por id.
// ---------------------------------------------------------------------

export const relacionamentosRegrasKeys = {
  all: ["relacionamentos-regras"] as QueryKey,
  lists: () => ["relacionamentos-regras", "list"] as QueryKey,
  list: (params: ListRelacionamentosRegrasParams): QueryKey => [
    "relacionamentos-regras",
    "list",
    params,
  ],
  details: () => ["relacionamentos-regras", "detail"] as QueryKey,
  detail: (id: string): QueryKey => ["relacionamentos-regras", "detail", id],
};

/** useRelacionamentosRegras - lista de regras humanas (com filtro ?ativa=). */
export function useRelacionamentosRegras(params: ListRelacionamentosRegrasParams = {}) {
  return useQuery({
    queryKey: relacionamentosRegrasKeys.list(params),
    queryFn: () => listRelacionamentosRegras(params),
  });
}

/** useRelacionamentosRegra - detalhe de 1 regra. */
export function useRelacionamentosRegra(id: string | undefined) {
  return useQuery({
    queryKey: relacionamentosRegrasKeys.detail(id ?? "-"),
    queryFn: () => getRelacionamentosRegra(id as string),
    enabled: Boolean(id),
  });
}

/** useCriarRelacionamentosRegra - POST. Invalida a lista. */
export function useCriarRelacionamentosRegra() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegraCreateInput) => createRelacionamentosRegra(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosRegrasKeys.all });
    },
  });
}

/** useEditarRelacionamentosRegra - PUT /:id (parcial). Invalida lista e detalhe. */
export function useEditarRelacionamentosRegra() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: RegraUpdateInput }) =>
      updateRelacionamentosRegra(id, input),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: relacionamentosRegrasKeys.all });
      queryClient.invalidateQueries({
        queryKey: relacionamentosRegrasKeys.detail(vars.id),
      });
    },
  });
}

/**
 * useAtivarRelacionamentosRegra - atalho para ativa/desativa sem mexer no
 * resto. Invalida a lista e o detalhe.
 */
export function useAtivarRelacionamentosRegra() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ativa }: { id: string; ativa: boolean }) =>
      toggleRelacionamentosRegra(id, ativa),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: relacionamentosRegrasKeys.all });
      queryClient.invalidateQueries({
        queryKey: relacionamentosRegrasKeys.detail(vars.id),
      });
    },
  });
}

/** useExcluirRelacionamentosRegra - DELETE /:id. Invalida a lista. */
export function useExcluirRelacionamentosRegra() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRelacionamentosRegra(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosRegrasKeys.all });
    },
  });
}
