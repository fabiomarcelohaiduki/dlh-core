"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { getParametrosResolvidos } from "@/lib/api/parametros";

/** Chaves de cache dos parametros resolvidos por produto. */
export const resolvidosKeys = {
  all: ["parametros-resolvidos"] as QueryKey,
  byProduto: (produtoId: string): QueryKey => [
    "parametros-resolvidos",
    produtoId,
  ],
};

/**
 * useParametrosResolvidos — valor EFETIVO de cada parametro escalar/regiao de
 * um Produto, com a origem (PRODUTO -> LINHA -> GLOBAL). Invalidada por upsert
 * de parametros.
 */
export function useParametrosResolvidos(
  produtoId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: resolvidosKeys.byProduto(produtoId ?? ""),
    queryFn: () => getParametrosResolvidos(produtoId as string),
    enabled: (options?.enabled ?? true) && Boolean(produtoId),
  });
}
