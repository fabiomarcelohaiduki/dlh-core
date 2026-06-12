"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { listPrecosPendentes } from "@/lib/api/parametros";

/** Chaves de cache da fila de SKUs pendentes/erro de recalculo. */
export const precoPendenteKeys = {
  all: ["precos-pendentes"] as QueryKey,
};

/**
 * usePrecosPendentes — SKUs com calculo pendente/erro (GET /precos/pendentes).
 * E invalidada por recalculo e por escritas que marcam SKUs para recalculo
 * (insumo-precos, composicao, custo de aquisicao, parametros).
 */
export function usePrecosPendentes(options?: {
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  return useQuery({
    queryKey: precoPendenteKeys.all,
    queryFn: () => listPrecosPendentes(),
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
  });
}
