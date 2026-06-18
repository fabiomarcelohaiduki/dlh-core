"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { listTriagem, type ListTriagemParams } from "@/lib/api/automacao";

/**
 * Intervalo de refetch leve da fila enquanto a aba esta aberta (FE-3). Sem SSE
 * no V1: a triagem avanca em rajadas (so com LionClaw aberto). O default do
 * TanStack (refetchIntervalInBackground=false) pausa o polling fora de foco.
 */
const REFETCH_INTERVAL_MS = 20_000;

/** Chaves de cache da fila de triagem (aba Triagem). */
export const triagemKeys = {
  all: ["triagem"] as QueryKey,
  list: (params: ListTriagemParams): QueryKey => ["triagem", "list", params],
};

/**
 * useTriagem — lista paginada de avisos triados (GET automacao-avisos),
 * filtravel por veredito. Refetch leve enquanto a aba esta aberta.
 */
export function useTriagem(params: ListTriagemParams = {}) {
  return useQuery({
    queryKey: triagemKeys.list(params),
    queryFn: () => listTriagem(params),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}
