"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createConhecimento,
  deleteConhecimento,
  listConhecimentos,
  updateConhecimento,
  type CreateConhecimentoInput,
  type UpdateConhecimentoInput,
} from "@/lib/api/automacao";

/** Chaves de cache da base de conhecimento por setor. */
export const conhecimentosKeys = {
  bySetor: (setor: string) => ["conhecimentos", setor] as QueryKey,
};

/** Lista a base de conhecimento de um setor (inclui inativos para o cockpit). */
export function useConhecimentos(setor: string) {
  return useQuery({
    queryKey: conhecimentosKeys.bySetor(setor),
    queryFn: () => listConhecimentos({ setor }),
  });
}

export function useCreateConhecimento(setor: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConhecimentoInput) => createConhecimento(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: conhecimentosKeys.bySetor(setor) });
    },
  });
}

export function useUpdateConhecimento(setor: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateConhecimentoInput) => updateConhecimento(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: conhecimentosKeys.bySetor(setor) });
    },
  });
}

export function useDeleteConhecimento(setor: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteConhecimento(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: conhecimentosKeys.bySetor(setor) });
    },
  });
}
