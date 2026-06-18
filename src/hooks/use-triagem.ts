"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import {
  listFila,
  listTriagem,
  type ListFilaParams,
  type ListTriagemParams,
} from "@/lib/api/automacao";

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

/** Chaves de cache da fila de avisos aguardando triagem (aba Fila). */
export const filaKeys = {
  all: ["triagem-fila"] as QueryKey,
  list: (params: ListFilaParams): QueryKey => ["triagem-fila", "list", params],
};

/**
 * useFila — lista paginada dos avisos aguardando triagem (GET
 * automacao-avisos?fila=true) + total da fila. Refetch leve enquanto a aba Fila
 * esta aberta: a fila drena em rajadas conforme a esteira processa.
 */
export function useFila(params: ListFilaParams = {}) {
  return useQuery({
    queryKey: filaKeys.list(params),
    queryFn: () => listFila(params),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}
