"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { getBacktestRecall, type BacktestParams } from "@/lib/api/automacao";

/** Chaves de cache do backtest de recall (aba Backtest). */
export const backtestKeys = {
  all: ["backtest-recall"] as QueryKey,
  result: (params: BacktestParams): QueryKey => [
    "backtest-recall",
    "result",
    params,
  ],
};

/**
 * useBacktestRecall — recall em modo sombra (GET automacao-backtest-recall).
 * Operacao pesada e somente leitura: por padrao so dispara quando ha um periodo
 * selecionado (`enabled`). Sem refetch automatico (calibracao manual).
 */
export function useBacktestRecall(
  params: BacktestParams = {},
  options?: { enabled?: boolean },
) {
  const hasPeriodo = Boolean(params.desde || params.ate);
  return useQuery({
    queryKey: backtestKeys.result(params),
    queryFn: () => getBacktestRecall(params),
    enabled: options?.enabled ?? hasPeriodo,
  });
}
