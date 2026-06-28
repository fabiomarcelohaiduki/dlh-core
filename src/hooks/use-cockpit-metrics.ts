"use client";

// =====================================================================
// use-cockpit-metrics — leitura read-only das execucoes para os cards (D-BE-04).
//
// Consome a lista de execucoes (fonte COCKPIT_SOURCES.runs) SEM dispará-la: o
// cockpit apenas consolida. Registra seu refetch como assinante do hook
// `refresh` dos ENGINES, de modo que `refreshCockpit()` force a releitura.
// =====================================================================

import { useEffect } from "react";
import { useExecucoes, useHealthcheck } from "@/hooks/use-monitoring";
import { useAutomacaoConfig } from "@/hooks/use-automacao-config";
import { ENGINES } from "@/lib/cockpit/cockpit-engines";
import type { AutomacaoConfig, Execucao, HealthcheckResponse } from "@/lib/api/types";

export interface CockpitMetricsState {
  runs: Execucao[];
  health: HealthcheckResponse | null;
  automacao: AutomacaoConfig | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useCockpitMetrics(): CockpitMetricsState {
  // Limite amplo o bastante para "execuções hoje" sem paginar; read-only.
  const query = useExecucoes({ limit: 100 });
  // Healthcheck alimenta os cards de escopo sem fonte em execucoes (ex.: Cadastros).
  const health = useHealthcheck({ refetchInterval: 30_000 });
  // Config de triagem alimenta o card do escopo Automações (modo da IA).
  const automacao = useAutomacaoConfig();
  const { refetch } = query;

  // Liga o refresh dos ENGINES ao refetch desta query.
  useEffect(() => {
    return ENGINES.onRefresh(() => {
      void refetch();
      void health.refetch();
      void automacao.refetch();
    });
  }, [refetch, health, automacao]);

  return {
    runs: query.data?.items ?? [],
    health: health.data ?? null,
    automacao: automacao.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => {
      void refetch();
    },
  };
}
