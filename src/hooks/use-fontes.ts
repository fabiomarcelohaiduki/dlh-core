"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  coletar,
  fetchIngestaoConfig,
  salvarIngestaoConfig,
  type ColetarInput,
  type SalvarIngestaoConfigInput,
} from "@/lib/api/fontes";
import { monitoringKeys } from "@/hooks/use-monitoring";
import type { PillState } from "@/lib/status";
import type { EstadoConexao, Fonte, FonteTipo } from "@/lib/api/types";

/** Chaves de cache das fontes (compartilhadas com use-admin/use-monitoring). */
export const fonteKeys = {
  all: ["fontes"] as QueryKey,
  conexoes: ["fontes-conexoes"] as QueryKey,
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
export function useFontes() {
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
  });
}

/** Estado de conexao por fonte para o indicador global do topbar. */
export interface FonteConexao {
  tipo: "effecti" | "nomus" | "drive" | "gmail";
  label: string;
  state: PillState;
}

/** Effecti/Nomus: 'erro' vence; conectada OU com coleta real = ok; senao idle. */
function saudeCredFonte(estado: string | null, ultimaColeta: string | null): PillState {
  if (estado === "erro") return "err";
  if (estado === "conectada" || ultimaColeta) return "ok";
  return "idle";
}

/**
 * useConexoesFontes — saude de conexao das 4 fontes para o indicador do topbar.
 * Le direto pelo cliente (RLS): public.fontes (Effecti/Nomus/Gmail: estado +
 * ultima coleta) e os singletons drive_conta/gmail_conta (conexao OAuth via
 * e-mail presente). A cor do ponto deriva do estado de cada fonte.
 */
export function useConexoesFontes() {
  return useQuery({
    queryKey: fonteKeys.conexoes,
    queryFn: async (): Promise<FonteConexao[]> => {
      const supabase = createClient();
      const [fontesRes, driveRes, gmailRes] = await Promise.all([
        supabase.from("fontes").select("tipo, estado_conexao, ultima_coleta_em"),
        supabase.from("drive_conta").select("email").eq("id", true).maybeSingle(),
        supabase.from("gmail_conta").select("email").eq("id", true).maybeSingle(),
      ]);
      if (fontesRes.error) throw new Error(fontesRes.error.message);

      const rows = (fontesRes.data ?? []) as FonteRow[];
      const byTipo = (tipo: string) => rows.find((r) => r.tipo === tipo) ?? null;
      const effecti = byTipo("effecti");
      const nomus = byTipo("nomus");
      const gmailFonte = byTipo("gmail");

      const driveConectado = Boolean((driveRes.data as { email: string | null } | null)?.email);
      const gmailConectado = Boolean((gmailRes.data as { email: string | null } | null)?.email);

      // Gmail: a conexao real e o e-mail no singleton; 'erro' no fontes ainda vence.
      const gmailState: PillState =
        gmailFonte?.estado_conexao === "erro" ? "err" : gmailConectado ? "ok" : "idle";

      return [
        {
          tipo: "effecti",
          label: "Effecti",
          state: saudeCredFonte(effecti?.estado_conexao ?? null, effecti?.ultima_coleta_em ?? null),
        },
        {
          tipo: "nomus",
          label: "Nomus",
          state: saudeCredFonte(nomus?.estado_conexao ?? null, nomus?.ultima_coleta_em ?? null),
        },
        { tipo: "drive", label: "Drive", state: driveConectado ? "ok" : "idle" },
        { tipo: "gmail", label: "Gmail", state: gmailState },
      ];
    },
    refetchInterval: 60_000,
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

/**
 * useColetar — dispara a coleta manual da fonte/recurso (POST ingestao-coletar).
 * Em sucesso (202) invalida execucoes, healthcheck e fontes (ultima_coleta_em).
 * O single-flight (409 `ja_em_andamento`) chega via ApiError para a UI tratar.
 */
export function useColetar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ColetarInput) => coletar(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: monitoringKeys.execucoesRoot });
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
      queryClient.invalidateQueries({ queryKey: fonteKeys.all });
    },
  });
}
