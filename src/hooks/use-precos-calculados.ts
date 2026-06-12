"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { getPrecosCalculados } from "@/lib/api/parametros";

/** Chaves de cache do grid de precos calculados por SKU. */
export const precoCalculadoKeys = {
  all: ["precos-calculados"] as QueryKey,
  bySku: (skuId: string): QueryKey => ["precos-calculados", skuId],
};

/**
 * usePrecosCalculados — grid (regiao x patamar) + estado + apoio de um SKU
 * (GET /skus/:skuId/precos). E invalidada por recalculo e edicao de apoio.
 */
export function usePrecosCalculados(
  skuId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: precoCalculadoKeys.bySku(skuId ?? ""),
    queryFn: () => getPrecosCalculados(skuId as string),
    enabled: (options?.enabled ?? true) && Boolean(skuId),
  });
}
