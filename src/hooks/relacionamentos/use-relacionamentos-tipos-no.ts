"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createTipoNo,
  listTiposNo,
  updateTipoNo,
  type TipoNoCreateInput,
  type TipoNoUpdateInput,
} from "@/lib/api/relacionamentos-tipos-no";

// ---------------------------------------------------------------------
// Chaves de cache dos tipos de no (config_tipos_no).
// A lista ja embute os campos reais de cada tabela_fonte, entao um unico
// key `list` cobre dropdowns do RegraForm e a tela de gestao de tipos.
// ---------------------------------------------------------------------

export const relacionamentosTiposNoKeys = {
  all: ["relacionamentos-tipos-no"] as QueryKey,
  list: () => ["relacionamentos-tipos-no", "list"] as QueryKey,
};

/** useRelacionamentosTiposNo - GET (tipos da org + campos da tabela_fonte). */
export function useRelacionamentosTiposNo() {
  return useQuery({
    queryKey: relacionamentosTiposNoKeys.list(),
    queryFn: () => listTiposNo(),
  });
}

/** useCriarRelacionamentosTipoNo - POST (tipo novo). Invalida a lista. */
export function useCriarRelacionamentosTipoNo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TipoNoCreateInput) => createTipoNo(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosTiposNoKeys.all });
    },
  });
}

/** useEditarRelacionamentosTipoNo - PUT /:tipo (parcial). Invalida a lista. */
export function useEditarRelacionamentosTipoNo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tipo, input }: { tipo: string; input: TipoNoUpdateInput }) =>
      updateTipoNo(tipo, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosTiposNoKeys.all });
    },
  });
}
