"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createDiretriz,
  createRegra,
  deleteDiretriz,
  deleteRegra,
  listDiretrizes,
  listRegras,
  updateDiretriz,
  updateRegra,
  type CotacaoDiretrizInput,
  type CotacaoRegraInput,
  type ListCriteriosParams,
} from "@/lib/api/criterios";

/** Chaves de cache das diretrizes e regras de cotacao. */
export const diretrizKeys = {
  all: ["cotacao-diretrizes"] as QueryKey,
  list: (params: ListCriteriosParams): QueryKey => [
    "cotacao-diretrizes",
    "list",
    params,
  ],
};

export const regraKeys = {
  all: ["cotacao-regras"] as QueryKey,
  list: (params: ListCriteriosParams): QueryKey => [
    "cotacao-regras",
    "list",
    params,
  ],
};

// --- Diretrizes -----------------------------------------------------

/** useDiretrizes — diretrizes textuais de cotacao por nivel/escopo. */
export function useDiretrizes(params: ListCriteriosParams = {}) {
  return useQuery({
    queryKey: diretrizKeys.list(params),
    queryFn: () => listDiretrizes(params),
  });
}

/** useCreateDiretriz — cria diretriz (POST). Invalida as diretrizes. */
export function useCreateDiretriz() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CotacaoDiretrizInput) => createDiretriz(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: diretrizKeys.all });
    },
  });
}

/** useUpdateDiretriz — edita diretriz (PUT /:id). Invalida as diretrizes. */
export function useUpdateDiretriz() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Partial<CotacaoDiretrizInput>;
    }) => updateDiretriz(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: diretrizKeys.all });
    },
  });
}

/** useDeleteDiretriz — remove diretriz (DELETE /:id). Invalida as diretrizes. */
export function useDeleteDiretriz() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteDiretriz(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: diretrizKeys.all });
    },
  });
}

// --- Regras ---------------------------------------------------------

/** useRegras — regras estruturadas de cotacao por nivel/escopo. */
export function useRegras(params: ListCriteriosParams = {}) {
  return useQuery({
    queryKey: regraKeys.list(params),
    queryFn: () => listRegras(params),
  });
}

/** useCreateRegra — cria regra (POST). Invalida as regras. */
export function useCreateRegra() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CotacaoRegraInput) => createRegra(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: regraKeys.all });
    },
  });
}

/** useUpdateRegra — edita regra (PUT /:id). Invalida as regras. */
export function useUpdateRegra() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Partial<CotacaoRegraInput>;
    }) => updateRegra(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: regraKeys.all });
    },
  });
}

/** useDeleteRegra — remove regra (DELETE /:id). Invalida as regras. */
export function useDeleteRegra() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRegra(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: regraKeys.all });
    },
  });
}
