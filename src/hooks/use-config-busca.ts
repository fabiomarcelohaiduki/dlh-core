"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { getConfigBusca, updateConfigBusca } from "@/lib/api/config-busca";
import type { ConfigBuscaInput } from "@/lib/api/types";

/** Chave de cache da config de busca/rerank (singleton). */
export const configBuscaKeys = {
  all: ["config-busca"] as QueryKey,
};

/** useConfigBusca — configuracao do rerank (GET /config-busca). */
export function useConfigBusca(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: configBuscaKeys.all,
    queryFn: getConfigBusca,
    enabled: options?.enabled ?? true,
  });
}

/** useUpdateConfigBusca — persiste a config de busca (PUT /config-busca). */
export function useUpdateConfigBusca() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConfigBuscaInput) => updateConfigBusca(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: configBuscaKeys.all });
    },
  });
}
