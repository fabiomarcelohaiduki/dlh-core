"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createLinha,
  deleteLinha,
  listLinhas,
  updateLinha,
  type LinhaInput,
  type ListLinhasParams,
} from "@/lib/api/produtos";

/** Chaves de cache das linhas de produto. */
export const linhaKeys = {
  all: ["produto-linhas"] as QueryKey,
  list: (params: ListLinhasParams): QueryKey => [
    "produto-linhas",
    "list",
    params,
  ],
};

/** useLinhas — lista paginada de linhas de produto (GET /produtos-linhas). */
export function useLinhas(params: ListLinhasParams = {}) {
  return useQuery({
    queryKey: linhaKeys.list(params),
    queryFn: () => listLinhas(params),
  });
}

/** useCreateLinha — cria linha (POST). Invalida a lista de linhas. */
export function useCreateLinha() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LinhaInput) => createLinha(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linhaKeys.all });
    },
  });
}

/** useUpdateLinha — atualiza linha (PUT /:id). Invalida a lista de linhas. */
export function useUpdateLinha() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<LinhaInput> }) =>
      updateLinha(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linhaKeys.all });
    },
  });
}

/** useDeleteLinha — remove linha (DELETE /:id). Invalida a lista de linhas. */
export function useDeleteLinha() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteLinha(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linhaKeys.all });
    },
  });
}
