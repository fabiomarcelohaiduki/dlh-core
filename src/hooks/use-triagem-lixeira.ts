"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { listLixeira, type ListLixeiraParams } from "@/lib/api/automacao";

/** Refetch leve da lixeira enquanto a aba esta aberta (FE-3, sem SSE no V1). */
const REFETCH_INTERVAL_MS = 20_000;

/** Chaves de cache da lixeira (aba Lixeira). */
export const lixeiraKeys = {
  all: ["triagem-lixeira"] as QueryKey,
  list: (params: ListLixeiraParams): QueryKey => [
    "triagem-lixeira",
    "list",
    params,
  ],
};

/**
 * useTriagemLixeira — avisos atualmente na lixeira (GET automacao-avisos?
 * lixeira=true). Refetch leve enquanto a aba esta aberta.
 */
export function useTriagemLixeira(params: ListLixeiraParams = {}) {
  return useQuery({
    queryKey: lixeiraKeys.list(params),
    queryFn: () => listLixeira(params),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}
