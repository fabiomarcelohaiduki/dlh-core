"use client";

// =====================================================================
// use-configuracao — CRUD live de `configuracao` + `bloco_config` (SPEC 3.1).
//
// Persistencia AO VIVO (sem botao Salvar): cada mutation aplica o patch e
// invalida o cache TanStack Query. A leitura roda o bootstrap (cria a
// configuracao default no primeiro login + migrador localStorage->Supabase),
// e ao concluir invalida o cache de `bloco_config` para refletir o que o
// migrador eventualmente importou.
// =====================================================================

import { useEffect } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  bootstrapConfiguracao,
  patchConfiguracao,
} from "@/lib/api/configuracao";
import {
  getBlocoConfig,
  pruneBlocoConfig,
  upsertBlocoConfigLote,
  type BlocoConfigUpsertInput,
} from "@/lib/api/bloco-config";
import type { Configuracao } from "@/types/domain";

/** Factory de chaves de cache. `blocos` aninha sob o prefixo `bloco-config`
 * para que a invalidacao por prefixo atinja todas as variantes de escopo. */
export const configuracaoKeys = {
  all: ["configuracao"] as QueryKey,
  blocosRoot: ["bloco-config"] as QueryKey,
  blocos: (escopo?: string, tipo?: string): QueryKey => [
    "bloco-config",
    escopo ?? "*",
    tipo ?? "*",
  ],
};

/**
 * Leitura da configuracao do usuario. No primeiro acesso, cria a linha default
 * (tema LionClaw, densidade confortavel) e roda o migrador de leitura unica.
 */
export function useConfiguracao(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: configuracaoKeys.all,
    queryFn: bootstrapConfiguracao,
    enabled: options?.enabled ?? true,
  });

  // Ao concluir o bootstrap, o migrador pode ter inserido linhas em
  // bloco_config: invalida o cache uma vez (quando a query vira success).
  useEffect(() => {
    if (query.isSuccess) {
      queryClient.invalidateQueries({ queryKey: configuracaoKeys.blocosRoot });
    }
    // Intencional: dispara apenas na transicao para success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isSuccess]);

  return query;
}

/** Mutation live de preferencias (PATCH configuracao, sem botao Salvar). */
export function usePatchConfiguracao() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Configuracao>) => patchConfiguracao(patch),
    onSuccess: (data) => {
      queryClient.setQueryData(configuracaoKeys.all, data);
      queryClient.invalidateQueries({ queryKey: configuracaoKeys.all });
    },
  });
}

/** Leitura de `bloco_config` por escopo hierarquico (opcional). */
export function useBlocoConfig(
  escopo?: string,
  tipo?: BlocoConfigUpsertInput["tipo"],
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: configuracaoKeys.blocos(escopo, tipo),
    queryFn: () => getBlocoConfig(escopo, tipo),
    enabled: options?.enabled ?? true,
  });
}

/** Mutation live de upsert em lote (visibilidade/ordem/banda/valor). */
export function useUpsertBlocoConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (items: BlocoConfigUpsertInput[]) =>
      upsertBlocoConfigLote(items),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: configuracaoKeys.blocosRoot });
    },
  });
}

/** Mutation de prune de orfaos (remocao em app code, SPEC 2.3.2). */
export function usePruneBlocoConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orfaoIds: string[]) => pruneBlocoConfig(orfaoIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: configuracaoKeys.blocosRoot });
    },
  });
}
