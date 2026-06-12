"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createLinhaAtributo,
  deleteLinhaAtributo,
  listLinhaAtributos,
  updateLinhaAtributo,
  type LinhaAtributoInput,
} from "@/lib/api/produtos";

/** Chaves de cache dos atributos de uma linha. */
export const linhaAtributoKeys = {
  all: ["linha-atributos"] as QueryKey,
  byLinha: (linhaId: string): QueryKey => ["linha-atributos", linhaId],
};

/** useLinhaAtributos — atributos validos de uma linha (GET /:id/atributos). */
export function useLinhaAtributos(
  linhaId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: linhaAtributoKeys.byLinha(linhaId ?? ""),
    queryFn: () => listLinhaAtributos(linhaId as string),
    enabled: (options?.enabled ?? true) && Boolean(linhaId),
  });
}

/** useCreateLinhaAtributo — adiciona atributo a linha. Invalida os atributos da linha. */
export function useCreateLinhaAtributo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      linhaId,
      input,
    }: {
      linhaId: string;
      input: LinhaAtributoInput;
    }) => createLinhaAtributo(linhaId, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: linhaAtributoKeys.byLinha(variables.linhaId),
      });
    },
  });
}

/** useUpdateLinhaAtributo — edita atributo da linha. Invalida os atributos da linha. */
export function useUpdateLinhaAtributo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      linhaId,
      atributoId,
      input,
    }: {
      linhaId: string;
      atributoId: string;
      input: Partial<LinhaAtributoInput>;
    }) => updateLinhaAtributo(linhaId, atributoId, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: linhaAtributoKeys.byLinha(variables.linhaId),
      });
    },
  });
}

/** useDeleteLinhaAtributo — remove atributo da linha. Invalida os atributos da linha. */
export function useDeleteLinhaAtributo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      linhaId,
      atributoId,
    }: {
      linhaId: string;
      atributoId: string;
    }) => deleteLinhaAtributo(linhaId, atributoId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: linhaAtributoKeys.byLinha(variables.linhaId),
      });
    },
  });
}
