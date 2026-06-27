"use client";

// =====================================================================
// use-cockpit-metrics — leitura read-only das execucoes para os cards (D-BE-04).
//
// Consome a lista de execucoes (fonte COCKPIT_SOURCES.runs) SEM dispará-la: o
// cockpit apenas consolida. Registra seu refetch como assinante do hook
// `refresh` dos ENGINES, de modo que `refreshCockpit()` force a releitura.
// =====================================================================

import { useEffect } from "react";
import { useExecucoes } from "@/hooks/use-monitoring";
import { ENGINES } from "@/lib/cockpit/cockpit-engines";
import type { Execucao } from "@/lib/api/types";

export interface CockpitMetricsState {
  runs: Execucao[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useCockpitMetrics(): CockpitMetricsState {
  // Limite amplo o bastante para "execuções hoje" sem paginar; read-only.
  const query = useExecucoes({ limit: 100 });
  const { refetch } = query;

  // Liga o refresh dos ENGINES ao refetch desta query.
  useEffect(() => {
    return ENGINES.onRefresh(() => {
      void refetch();
    });
  }, [refetch]);

  return {
    runs: query.data?.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => {
      void refetch();
    },
  };
}
