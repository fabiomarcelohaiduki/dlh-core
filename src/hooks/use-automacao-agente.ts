"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  getAgenteConfig,
  updateAgenteConfig,
  type AgenteConfigInput,
} from "@/lib/api/automacao";

/** Chaves de cache da persona do subagente especialista (E15). */
export const agenteConfigKeys = {
  all: ["automacao-agente"] as QueryKey,
};

/** useAutomacaoAgente — persona versionada (GET automacao-agente-config). */
export function useAutomacaoAgente() {
  return useQuery({
    queryKey: agenteConfigKeys.all,
    queryFn: () => getAgenteConfig(),
  });
}

/**
 * useUpdateAutomacaoAgente — atualiza a persona/prompt + ferramentas (PUT). O
 * backend incrementa a versao. Invalida a config do agente no onSuccess.
 */
export function useUpdateAutomacaoAgente() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AgenteConfigInput) => updateAgenteConfig(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agenteConfigKeys.all });
    },
  });
}
