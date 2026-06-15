"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { getConfigLlm, updateConfigLlm } from "@/lib/api/config-llm";
import type { ConfigLlmInput } from "@/lib/api/types";

/** Chave de cache da config de IA (singleton). */
export const configLlmKeys = {
  all: ["config-llm"] as QueryKey,
};

/** useConfigLlm — configuracao da IA (GET /config-llm). */
export function useConfigLlm(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: configLlmKeys.all,
    queryFn: getConfigLlm,
    enabled: options?.enabled ?? true,
  });
}

/** useUpdateConfigLlm — persiste a config de IA (PUT /config-llm). */
export function useUpdateConfigLlm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConfigLlmInput) => updateConfigLlm(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: configLlmKeys.all });
    },
  });
}
