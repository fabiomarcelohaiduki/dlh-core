"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createRelacionamentosTipo,
  getRelacionamentosConfig,
  listRelacionamentosTipos,
  updateRelacionamentosConfig,
  updateRelacionamentosTipo,
} from "@/lib/api/relacionamentos-config";
import type {
  ConfigRelacionamentosUpdateInput,
  ConfigTipoNoCreateInput,
  ConfigTipoNoUpdateInput,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Chaves de cache da config singleton + tipos de no.
// ---------------------------------------------------------------------

export const relacionamentosConfigKeys = {
  all: ["relacionamentos-config"] as QueryKey,
  detail: () => ["relacionamentos-config", "detail"] as QueryKey,
  tipos: () => ["relacionamentos-config", "tipos"] as QueryKey,
};

/** useRelacionamentosConfig - GET /relacionamentos-config (singleton). */
export function useRelacionamentosConfig() {
  return useQuery({
    queryKey: relacionamentosConfigKeys.detail(),
    queryFn: () => getRelacionamentosConfig(),
  });
}

/** useUpdateRelacionamentosConfig - PUT (parcial). Invalida a config. */
export function useUpdateRelacionamentosConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConfigRelacionamentosUpdateInput) =>
      updateRelacionamentosConfig(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosConfigKeys.detail() });
    },
  });
}

/** useRelacionamentosTipos - GET /relacionamentos-config/tipos. */
export function useRelacionamentosTipos() {
  return useQuery({
    queryKey: relacionamentosConfigKeys.tipos(),
    queryFn: () => listRelacionamentosTipos(),
  });
}

/**
 * useUpsertRelacionamentosTipo - POST ou PUT (decide pelo caller). O backend
 * trata POST como criar (UNIQUE org+tipo) e PUT como upsert/update. Encapsular
 * em um unico hook para a UI escolher; a UI decide passando o input correto.
 *
 * Invalida a lista de tipos em qualquer caminho.
 */
export function useUpsertRelacionamentosTipo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfigTipoNoCreateInput | ConfigTipoNoUpdateInput) => {
      // `id` identifica edicao de linha existente. Sem `id`, a intencao e criar.
      const updateShape = input as ConfigTipoNoUpdateInput;
      if (updateShape.id) {
        return updateRelacionamentosTipo(updateShape);
      }
      return createRelacionamentosTipo(input as ConfigTipoNoCreateInput);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosConfigKeys.tipos() });
    },
  });
}
