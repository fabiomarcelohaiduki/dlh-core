"use client";

import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { curarExtracaoSuspeita, listExtracaoSuspeitasFila } from "@/lib/api/automacao";
import type { ExtracaoSuspeitaCurarInput } from "@/lib/api/types";
import { avisoItensKeys } from "@/hooks/use-aviso-itens";

/** Chaves de cache da fila de revisao de extracao (suspeitas). */
export const extracaoSuspeitasKeys = {
  all: ["extracao-suspeitas"] as QueryKey,
  fila: (status: string): QueryKey => ["extracao-suspeitas", "fila", status],
};

/** useExtracaoSuspeitasFila — fila de suspeitas de extracao. Default pendente. */
export function useExtracaoSuspeitasFila(status: string = "pendente") {
  return useQuery({
    queryKey: extracaoSuspeitasKeys.fila(status),
    queryFn: () => listExtracaoSuspeitasFila(status),
  });
}

/**
 * useCurarExtracaoSuspeita — confirma/corrige/descarta uma suspeita. Invalida a
 * fila e os itens de aviso (a curadoria muda o que reaparece na re-extracao e o
 * sinal de recall no painel).
 */
export function useCurarExtracaoSuspeita() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ExtracaoSuspeitaCurarInput) => curarExtracaoSuspeita(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: extracaoSuspeitasKeys.all });
      queryClient.invalidateQueries({ queryKey: avisoItensKeys.all });
    },
  });
}
