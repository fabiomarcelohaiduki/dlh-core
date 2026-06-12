"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { recalcularSku } from "@/lib/api/parametros";
import { precoCalculadoKeys } from "@/hooks/use-precos-calculados";
import { precoPendenteKeys } from "@/hooks/use-precos-pendentes";

/**
 * useRecalcularSku — forca o recalculo do grid de precos de um SKU (POST
 * /skus/:skuId/recalcular). Em sucesso invalida o grid de precos do SKU E a
 * fila de pendentes (o SKU sai/entra da fila conforme o resultado).
 */
export function useRecalcularSku() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skuId: string) => recalcularSku(skuId),
    onSuccess: (_data, skuId) => {
      queryClient.invalidateQueries({
        queryKey: precoCalculadoKeys.bySku(skuId),
      });
      queryClient.invalidateQueries({ queryKey: precoPendenteKeys.all });
    },
  });
}
