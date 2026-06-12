"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { getTabelaPrecos } from "@/lib/api/parametros";

/** Chaves de cache da tabela de precos consolidada por Linha. */
export const tabelaPrecoKeys = {
  all: ["tabela-precos"] as QueryKey,
  byLinha: (linhaId: string): QueryKey => ["tabela-precos", linhaId],
};

/**
 * useTabelaPrecos — Tabela de Preços da Linha inteira (GET /precos/consolidado):
 * todos os Produtos -> SKUs -> celulas (regiao x patamar) num so payload.
 */
export function useTabelaPrecos(
  linhaId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: tabelaPrecoKeys.byLinha(linhaId ?? ""),
    queryFn: () => getTabelaPrecos(linhaId as string),
    enabled: (options?.enabled ?? true) && Boolean(linhaId),
  });
}
