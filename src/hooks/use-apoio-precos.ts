"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updatePrecoApoio } from "@/lib/api/parametros";
import { precoCalculadoKeys } from "@/hooks/use-precos-calculados";
import type { PrecoApoio } from "@/lib/api/types";

/**
 * useApoioPrecos — grava os indicadores de apoio do SKU (PUT /skus/:skuId/precos/
 * apoio): ifp, preco_concorrencia, custo_ideal (RF-23, unicos campos gravaveis
 * do grid). Em sucesso invalida o grid de precos do SKU.
 */
export function useApoioPrecos() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ skuId, apoio }: { skuId: string; apoio: PrecoApoio }) =>
      updatePrecoApoio(skuId, apoio),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: precoCalculadoKeys.bySku(variables.skuId),
      });
    },
  });
}
