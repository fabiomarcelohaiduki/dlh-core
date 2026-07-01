"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createRelacionamentosVinculoLia,
  decidirRelacionamentosVinculoLia,
  deleteRelacionamentosVinculoLia,
  getRelacionamentosVinculoLia,
  listRelacionamentosVinculosLia,
  updateRelacionamentosVinculoLia,
} from "@/lib/api/relacionamentos-vinculos-lia";
import type {
  ListRelacionamentosVinculosParams,
  VinculoLiaCreateInput,
  VinculoLiaDecidirInput,
  VinculoLiaUpdateInput,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Chaves de cache dos vinculos inferidos pela Lia.
// ---------------------------------------------------------------------

export const relacionamentosVinculosLiaKeys = {
  all: ["relacionamentos-vinculos-lia"] as QueryKey,
  lists: () => ["relacionamentos-vinculos-lia", "list"] as QueryKey,
  list: (params: ListRelacionamentosVinculosParams): QueryKey => [
    "relacionamentos-vinculos-lia",
    "list",
    params,
  ],
  details: () => ["relacionamentos-vinculos-lia", "detail"] as QueryKey,
  detail: (id: string): QueryKey => ["relacionamentos-vinculos-lia", "detail", id],
};

/** useRelacionamentosVinculosLia - lista (filtro ?status=&origem=). */
export function useRelacionamentosVinculosLia(
  params: ListRelacionamentosVinculosParams = {},
) {
  return useQuery({
    queryKey: relacionamentosVinculosLiaKeys.list(params),
    queryFn: () => listRelacionamentosVinculosLia(params),
  });
}

/** useRelacionamentosVinculoLia - detalhe de 1 vinculo. */
export function useRelacionamentosVinculoLia(id: string | undefined) {
  return useQuery({
    queryKey: relacionamentosVinculosLiaKeys.detail(id ?? "-"),
    queryFn: () => getRelacionamentosVinculoLia(id as string),
    enabled: Boolean(id),
  });
}

/** useCriarRelacionamentosVinculoLia - POST. Invalida a lista. */
export function useCriarRelacionamentosVinculoLia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: VinculoLiaCreateInput) => createRelacionamentosVinculoLia(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosVinculosLiaKeys.all });
    },
  });
}

/** useEditarRelacionamentosVinculoLia - PUT /:id (parcial). */
export function useEditarRelacionamentosVinculoLia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: VinculoLiaUpdateInput }) =>
      updateRelacionamentosVinculoLia(id, input),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: relacionamentosVinculosLiaKeys.all });
      queryClient.invalidateQueries({
        queryKey: relacionamentosVinculosLiaKeys.detail(vars.id),
      });
    },
  });
}

/** useExcluirRelacionamentosVinculoLia - DELETE /:id. */
export function useExcluirRelacionamentosVinculoLia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRelacionamentosVinculoLia(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosVinculosLiaKeys.all });
    },
  });
}

/**
 * useDecidirVinculoLia - POST /decidir (aprovar / rejeitar / editar).
 * A decisao pode CASCARAR uma regra humana nova (acao='aprovar') - entao
 * invalida tambem o catalogo de regras. O vinculo muda de status - entao
 * a lista do proprio vinculo e invalidada.
 */
export function useDecidirVinculoLia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: VinculoLiaDecidirInput) => decidirRelacionamentosVinculoLia(input),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: relacionamentosVinculosLiaKeys.all });
      queryClient.invalidateQueries({
        queryKey: relacionamentosVinculosLiaKeys.detail(vars.vinculo_id),
      });
      // aprovar pode criar regra humana nova; mantemos cache coerente.
      queryClient.invalidateQueries({ queryKey: ["relacionamentos-regras"] });
    },
  });
}
