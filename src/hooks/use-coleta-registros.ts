"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import {
  fetchColetaRegistros,
  fetchColetaRegistroDetalhe,
  type ColetaRegistrosParams,
  type ColetaRegistrosResponse,
} from "@/lib/api/coleta-registros";

/**
 * Polling adaptativo da guia "Dados" (sem Realtime — US-LISTA-03). Enquanto
 * houver registro visivel com indexacao `em_andamento`, encurta o intervalo
 * (RUNNING_POLL_MS) para refletir o progresso; caso contrario cai no intervalo
 * de fundo (FALLBACK_POLL_MS). Espelha o padrao de poll do monitoramento.
 */
export const RUNNING_POLL_MS = 3000;
export const FALLBACK_POLL_MS = 5000;

/** Chaves de cache centralizadas da guia "Dados" (padrao monitoringKeys). */
export const coletaRegistrosKeys = {
  all: ["coleta-registros"] as QueryKey,
  list: (params: ColetaRegistrosParams): QueryKey => ["coleta-registros", "list", params],
  detail: (id: string): QueryKey => ["coleta-registros", "detail", id],
};

/**
 * useColetaRegistros — lista mestra cumulativa (GET /coleta-registros) com
 * polling adaptativo (3s com indexacao ativa, 5s em repouso). Nao revalida em
 * background (refetchIntervalInBackground:false), mas revalida ao focar a aba
 * (refetchOnWindowFocus:true). Sem subscription Supabase (US-LISTA-03).
 */
export function useColetaRegistros(
  params: ColetaRegistrosParams = {},
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: coletaRegistrosKeys.list(params),
    queryFn: ({ signal }) => fetchColetaRegistros(params, signal),
    enabled: options?.enabled ?? true,
    refetchInterval: (query) => {
      const data = query.state.data as ColetaRegistrosResponse | undefined;
      const running = data?.itens.some(
        (item) => item.statusIndexacaoAgregado === "em_andamento",
      );
      return running ? RUNNING_POLL_MS : FALLBACK_POLL_MS;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

/**
 * useColetaRegistroDetalhe — detalhe expandido de 1 registro
 * (GET /coleta-registros/:id_composto). LAZY: so dispara quando o registro e
 * expandido na UI (`enabled` controlado externamente) e o id_composto existe.
 */
export function useColetaRegistroDetalhe(
  idComposto: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: coletaRegistrosKeys.detail(idComposto ?? "—"),
    queryFn: ({ signal }) => fetchColetaRegistroDetalhe(idComposto as string, signal),
    enabled: (options?.enabled ?? true) && Boolean(idComposto),
    refetchOnWindowFocus: true,
  });
}
