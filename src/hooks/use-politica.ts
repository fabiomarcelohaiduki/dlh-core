"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createPolitica,
  deletePolitica,
  listPolitica,
  updatePolitica,
  type ListCriteriosParams,
  type PoliticaParticipacaoInput,
} from "@/lib/api/criterios";

/** Chaves de cache da politica de participacao. */
export const politicaKeys = {
  all: ["politica-participacao"] as QueryKey,
  list: (params: ListCriteriosParams): QueryKey => [
    "politica-participacao",
    "list",
    params,
  ],
};

/** usePolitica — politica de participacao em licitacao por nivel/escopo. */
export function usePolitica(params: ListCriteriosParams = {}) {
  return useQuery({
    queryKey: politicaKeys.list(params),
    queryFn: () => listPolitica(params),
  });
}

/** useCreatePolitica — cria politica (POST). Invalida a politica. */
export function useCreatePolitica() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PoliticaParticipacaoInput) => createPolitica(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: politicaKeys.all });
    },
  });
}

/** useUpdatePolitica — edita politica (PUT /:id). Invalida a politica. */
export function useUpdatePolitica() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Partial<PoliticaParticipacaoInput>;
    }) => updatePolitica(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: politicaKeys.all });
    },
  });
}

/** useDeletePolitica — remove politica (DELETE /:id). Invalida a politica. */
export function useDeletePolitica() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePolitica(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: politicaKeys.all });
    },
  });
}
