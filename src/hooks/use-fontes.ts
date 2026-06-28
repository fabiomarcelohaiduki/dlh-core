"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  fetchIngestaoConfig,
  salvarIngestaoConfig,
  type SalvarIngestaoConfigInput,
} from "@/lib/api/fontes";
import type { EstadoConexao, Fonte, FonteTipo } from "@/lib/api/types";

/** Chaves de cache das fontes (compartilhadas com use-admin/use-monitoring). */
export const fonteKeys = {
  all: ["fontes"] as QueryKey,
  config: (fonte: FonteTipo): QueryKey => ["ingestao-config", fonte],
};

/** Linha crua de public.fontes lida via RLS do usuario autorizado. */
interface FonteRow {
  id: string;
  tipo: string;
  estado_conexao: string | null;
  ativa: boolean | null;
  ordem: number | null;
  ultima_coleta_em: string | null;
}

function toFonte(row: FonteRow): Fonte {
  return {
    id: row.id,
    tipo: row.tipo as FonteTipo,
    estadoConexao: (row.estado_conexao as EstadoConexao) ?? "nao_configurada",
    ativa: row.ativa ?? false,
    ordem: row.ordem ?? 0,
    ultimaColetaEm: row.ultima_coleta_em ?? null,
  };
}

/**
 * useFontes — lista as fontes do substrato (saude por fonte). Le direto de
 * public.fontes pelo cliente do browser (RLS do usuario autorizado), sem
 * expor o segredo (token_cifrado nao e selecionado). Alimenta o cmp-fonte-saude
 * (estado_conexao + ultima_coleta_em) e e invalidada por teste/coleta.
 */
export function useFontes(options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: fonteKeys.all,
    queryFn: async (): Promise<Fonte[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("fontes")
        .select("id, tipo, estado_conexao, ativa, ordem, ultima_coleta_em")
        .order("ordem", { ascending: true });
      if (error) throw new Error(error.message);
      return ((data ?? []) as FonteRow[]).map(toFonte);
    },
    refetchInterval: options?.refetchInterval ?? false,
  });
}

/**
 * useIngestaoConfig — config corrente da fonte (GET ingestao-config). Hidrata
 * o cmp-cfg-form (janela + recursos/tipos). Habilitavel via `enabled` para so
 * buscar quando o painel de configuracao estiver aberto.
 */
export function useIngestaoConfig(fonte: FonteTipo, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: fonteKeys.config(fonte),
    queryFn: () => fetchIngestaoConfig(fonte),
    enabled: options?.enabled ?? true,
  });
}

/**
 * useSalvarIngestaoConfig — persiste janela/recursos/tipos da fonte (PUT
 * ingestao-config). Em sucesso invalida a config para refletir o snapshot
 * vigente. Vale na proxima execucao, sem redeploy.
 */
export function useSalvarIngestaoConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SalvarIngestaoConfigInput) => salvarIngestaoConfig(input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: fonteKeys.config(variables.fonte) });
    },
  });
}
