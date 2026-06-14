"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  getConfigEmpresa,
  updateConfigEmpresa,
} from "@/lib/api/config-empresa";
import type { ConfigEmpresa } from "@/lib/api/types";

/** Chave de cache da config institucional (singleton). */
export const configEmpresaKeys = {
  all: ["config-empresa"] as QueryKey,
};

/** useConfigEmpresa — dados institucionais da DLH (GET /config-empresa). */
export function useConfigEmpresa(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: configEmpresaKeys.all,
    queryFn: getConfigEmpresa,
    enabled: options?.enabled ?? true,
  });
}

/** useUpdateConfigEmpresa — persiste a config (PUT /config-empresa). */
export function useUpdateConfigEmpresa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConfigEmpresa) => updateConfigEmpresa(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: configEmpresaKeys.all });
    },
  });
}
