"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  getAutomacaoConfig,
  updateAutomacaoConfig,
  type AutomacaoConfigInput,
} from "@/lib/api/automacao";
import { triagemKeys } from "@/hooks/use-triagem";
import { lixeiraKeys } from "@/hooks/use-triagem-lixeira";

/** Chaves de cache da config singleton (aba Configuracao). */
export const automacaoConfigKeys = {
  all: ["automacao-config"] as QueryKey,
};

/** useAutomacaoConfig — config singleton (GET automacao-config). */
export function useAutomacaoConfig() {
  return useQuery({
    queryKey: automacaoConfigKeys.all,
    queryFn: () => getAutomacaoConfig(),
  });
}

/**
 * useUpdateAutomacaoConfig — atualiza a config (PUT). Invalida a config e, como
 * alterar limiares re-deriva o veredito vigente dos avisos (E3), tambem a fila
 * de triagem e a lixeira.
 */
export function useUpdateAutomacaoConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AutomacaoConfigInput) => updateAutomacaoConfig(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: automacaoConfigKeys.all });
      queryClient.invalidateQueries({ queryKey: triagemKeys.all });
      queryClient.invalidateQueries({ queryKey: lixeiraKeys.all });
    },
  });
}
