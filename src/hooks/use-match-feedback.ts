"use client";

import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { listMatchFeedbackFila, sendMatchFeedback } from "@/lib/api/automacao";
import { getProduto } from "@/lib/api/produtos";
import type { MatchFeedbackInput, ProdutoSku } from "@/lib/api/types";
import { avisoItensKeys } from "@/hooks/use-aviso-itens";

/** Chaves de cache do feedback de match (fila de aprendizado + SKUs por produto). */
export const matchFeedbackKeys = {
  all: ["match-feedback"] as QueryKey,
  fila: (status: string): QueryKey => ["match-feedback", "fila", status],
  skus: (produtoId: string): QueryKey => ["match-feedback", "skus", produtoId],
};

/**
 * useSendMatchFeedback — grava a correcao humana do match (POST upsert).
 * Invalida os itens do aviso (reflete na linha) e a fila de aprendizado.
 */
export function useSendMatchFeedback(avisoId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MatchFeedbackInput) => sendMatchFeedback(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: avisoItensKeys.byAviso(avisoId) });
      queryClient.invalidateQueries({ queryKey: matchFeedbackKeys.all });
    },
  });
}

/** useMatchFeedbackFila — fila de correcoes (aba Aprendizado). Default pendente. */
export function useMatchFeedbackFila(status: string = "pendente") {
  return useQuery({
    queryKey: matchFeedbackKeys.fila(status),
    queryFn: () => listMatchFeedbackFila(status),
  });
}

/**
 * useProdutoSkus — SKUs de um produto, para o seletor dependente do painel de
 * correcao. Busca LAZY (so quando um produto esta selecionado).
 */
export function useProdutoSkus(produtoId: string | null) {
  return useQuery<ProdutoSku[]>({
    queryKey: matchFeedbackKeys.skus(produtoId ?? ""),
    queryFn: async () => {
      const detalhe = await getProduto(produtoId as string);
      return detalhe.skus;
    },
    enabled: !!produtoId,
  });
}
