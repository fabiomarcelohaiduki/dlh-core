"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type Query,
  type QueryKey,
} from "@tanstack/react-query";
import {
  dispararColeta,
  fetchErros,
  fetchExecucoes,
  fetchHealthcheck,
} from "@/lib/api/monitoring";
import type { ExecucoesResponse } from "@/lib/api/types";

/**
 * refetchInterval da lista de execucoes: aceita numero fixo, false ou a forma
 * de funcao do TanStack — esta ultima recebe a query e devolve o intervalo a
 * partir do estado ja carregado (ex: poll so enquanto houver coleta ativa).
 */
type ExecucoesRefetch =
  | number
  | false
  | ((query: Query<ExecucoesResponse>) => number | false);

/** Chaves de cache centralizadas (compartilhadas com o Realtime). */
export const monitoringKeys = {
  healthcheck: ["healthcheck"] as QueryKey,
  execucoes: (limit: number): QueryKey => ["execucoes", limit],
  execucoesRoot: ["execucoes"] as QueryKey,
  erros: (etapa: string | undefined): QueryKey => ["erros", etapa ?? "todos"],
  errosRoot: ["erros"] as QueryKey,
};

/** useHealthcheck — KPIs e saude do pipeline (GET /ingestao/healthcheck). */
export function useHealthcheck(options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: monitoringKeys.healthcheck,
    queryFn: ({ signal }) => fetchHealthcheck(signal),
    refetchInterval: options?.refetchInterval ?? false,
  });
}

/** useExecucoes — historico de execucoes (GET /ingestao/execucoes?limit). */
export function useExecucoes(options?: {
  limit?: number;
  refetchInterval?: ExecucoesRefetch;
}) {
  const limit = options?.limit ?? 50;
  return useQuery({
    queryKey: monitoringKeys.execucoes(limit),
    queryFn: ({ signal }) => fetchExecucoes(limit, signal),
    refetchInterval: options?.refetchInterval ?? false,
  });
}

/** useErros — erros de ingestao, filtraveis por etapa (GET /ingestao/erros). */
export function useErros(etapa?: string) {
  return useQuery({
    queryKey: monitoringKeys.erros(etapa),
    queryFn: ({ signal }) => fetchErros(etapa, signal),
  });
}

/**
 * useColetaDemanda — dispara a coleta sob demanda (POST /ingestao/coletar).
 * Em sucesso invalida execucoes e healthcheck; o anti-duplo-disparo (409
 * `execucao_em_andamento`) chega via ApiError para a UI tratar.
 */
export function useColetaDemanda() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (janelaDias?: number) => dispararColeta(janelaDias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: monitoringKeys.execucoesRoot });
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
    },
  });
}
