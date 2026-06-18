"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sendFeedback, type FeedbackInput } from "@/lib/api/automacao";
import { triagemKeys } from "@/hooks/use-triagem";
import { lixeiraKeys } from "@/hooks/use-triagem-lixeira";
import { exemploKeys } from "@/hooks/use-triagem-exemplos";

/**
 * useTriagemFeedback — grava feedback humano (POST automacao-feedback) na
 * decisao vigente e gera/atualiza o exemplo rotulado. Invalida a fila de
 * triagem, a lixeira e o acervo few-shot (o feedback substitui o exemplo).
 */
export function useTriagemFeedback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FeedbackInput) => sendFeedback(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: triagemKeys.all });
      queryClient.invalidateQueries({ queryKey: lixeiraKeys.all });
      queryClient.invalidateQueries({ queryKey: exemploKeys.all });
    },
  });
}
