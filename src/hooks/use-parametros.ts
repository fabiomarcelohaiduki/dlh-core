"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  getParametros,
  getParametrosRegional,
  upsertParametros,
  upsertParametrosRegional,
  type ParametroEscopo,
  type ParametrosCalculoInput,
  type ParametrosRegionalInput,
} from "@/lib/api/parametros";
import { resolvidosKeys } from "@/hooks/use-parametros-resolvidos";
import { precoPendenteKeys } from "@/hooks/use-precos-pendentes";

/** Chaves de cache dos parametros de calculo (escalares + vetor regional). */
export const parametroKeys = {
  all: ["parametros"] as QueryKey,
  escalares: (escopo: ParametroEscopo): QueryKey => [
    "parametros",
    "escalares",
    escopo.nivel,
    escopo.escopo_id ?? null,
  ],
  regional: (escopo: ParametroEscopo): QueryKey => [
    "parametros",
    "regional",
    escopo.nivel,
    escopo.escopo_id ?? null,
  ],
};

/** useParametros — parametros escalares de um nivel/escopo (GET /parametros). */
export function useParametros(
  escopo: ParametroEscopo,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: parametroKeys.escalares(escopo),
    queryFn: () => getParametros(escopo),
    enabled: options?.enabled ?? true,
  });
}

/** useParametrosRegional — vetor regional de um nivel/escopo (GET /parametros-regional). */
export function useParametrosRegional(
  escopo: ParametroEscopo,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: parametroKeys.regional(escopo),
    queryFn: () => getParametrosRegional(escopo),
    enabled: options?.enabled ?? true,
  });
}

/**
 * useUpsertParametros — upsert dos parametros escalares (PUT /parametros).
 * Invalida parametros, parametros resolvidos e a fila de pendentes (o backend
 * marca SKUs do escopo para recalculo).
 */
export function useUpsertParametros() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ParametrosCalculoInput) => upsertParametros(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: parametroKeys.all });
      queryClient.invalidateQueries({ queryKey: resolvidosKeys.all });
      queryClient.invalidateQueries({ queryKey: precoPendenteKeys.all });
    },
  });
}

/** useUpsertParametrosRegional — upsert do vetor regional (PUT /parametros-regional). */
export function useUpsertParametrosRegional() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ParametrosRegionalInput) =>
      upsertParametrosRegional(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: parametroKeys.all });
      queryClient.invalidateQueries({ queryKey: resolvidosKeys.all });
      queryClient.invalidateQueries({ queryKey: precoPendenteKeys.all });
    },
  });
}
