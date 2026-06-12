"use client";

import { useQuery } from "@tanstack/react-query";
import { getProduto } from "@/lib/api/produtos";
import { produtoKeys } from "@/hooks/use-produtos";

/**
 * useProduto — detalhe agregado do produto (GET /produtos/:id): produto +
 * atributos_schema + skus + imagens. Invalidada por escritas de produto/SKU.
 */
export function useProduto(
  id: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: produtoKeys.detail(id ?? ""),
    queryFn: () => getProduto(id as string),
    enabled: (options?.enabled ?? true) && Boolean(id),
  });
}
