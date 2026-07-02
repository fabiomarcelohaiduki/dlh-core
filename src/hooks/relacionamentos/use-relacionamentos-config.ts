"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  getRelacionamentosConfig,
  updateRelacionamentosConfig,
} from "@/lib/api/relacionamentos-config";
import type { ConfigRelacionamentosUpdateInput } from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Chaves de cache da config singleton.
// ---------------------------------------------------------------------

export const relacionamentosConfigKeys = {
  all: ["relacionamentos-config"] as QueryKey,
  detail: () => ["relacionamentos-config", "detail"] as QueryKey,
};

/** useRelacionamentosConfig - GET /relacionamentos-config (singleton). */
export function useRelacionamentosConfig() {
  return useQuery({
    queryKey: relacionamentosConfigKeys.detail(),
    queryFn: () => getRelacionamentosConfig(),
  });
}

/** useUpdateRelacionamentosConfig - PUT (parcial). Invalida a config. */
export function useUpdateRelacionamentosConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConfigRelacionamentosUpdateInput) =>
      updateRelacionamentosConfig(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosConfigKeys.detail() });
    },
  });
}
