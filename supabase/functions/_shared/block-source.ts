// =====================================================================
// _shared/block-source.ts
// Seam de ciclo de vida da coleta em BLOCOS, agnostico de fonte.
//
// Concentra, numa unica superficie:
//   - o ENVELOPE de checkpoint generico (campos de ciclo comuns a toda fonte
//     coletavel em blocos; o cursor especifico fica opaco/aninhado);
//   - a INTERFACE BlockSourceAdapter (ciclo de vida de UMA fonte);
//   - o PARSER/BUILDER puros do envelope, tolerantes ao formato legado plano
//     (campos de ciclo no topo, sem `cursor`) — sem I/O, testaveis por tabela;
//   - os HELPERS compartilhados (envInt/formatDuration/janelaMovel/loadCounters/
//     updateExecucao/finalizeConcluida) hoje duplicados byte-a-byte entre
//     nomus-pipeline.ts e effecti-pipeline.ts;
//   - a AUTO-CURA de orfa generica por heartbeat (updated_at), portada do
//     orquestrador (index.ts) e generalizando o EFFECTI_ORPHAN_STALE_MS.
//
// Esta extracao NAO reescreve logica: replica o comportamento atual dos
// pipelines/orquestrador. parseEnvelope/buildEnvelope/isOrfa/blockOrphanStaleMs
// sao computacao PURA (sem I/O). Toda escrita usa service_role server-side
// (SEC-05). NUNCA usa Claude na ingestao (embeddings bge-m3, RNF-04).
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { type EmbeddingProvider } from "./embeddings.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// 5.1 Envelope de checkpoint generico (D2)
// ---------------------------------------------------------------------

export type CheckpointFase = "coleta" | "concluido";
export type CheckpointModo = "incremental" | "backfill";

/**
 * Envelope de ciclo comum a TODA fonte coletavel em blocos. O cursor e opaco
 * ao seam: cada adapter declara seu TCursor.
 */
export interface CheckpointEnvelope<TCursor> {
  /** ISO-8601, limite inferior global da janela. */
  janela_inicio: string;
  /** ISO-8601, limite superior global da janela. */
  janela_fim: string;
  /** Fase corrente: "coleta" | "concluido". */
  fase: CheckpointFase;
  /** Tentativas de retomada apos erro (>= 0, teto via adapter.maxRetomadas()). */
  tentativas_retomada: number;
  /** Modo do ciclo: "incremental" (janela movel) | "backfill" (data_inicial). */
  modo: CheckpointModo;
  /** Cursor especifico da fonte (aninhado, opaco ao seam). */
  cursor: TCursor;
}

// ---------------------------------------------------------------------
// 5.2 Interface do adapter (D1)
// ---------------------------------------------------------------------

/** Tipos de linha consumidos pelos adapters (status quo, definidos localmente
 *  no orquestrador/vault hoje — re-declarados aqui para o seam nao depender de
 *  modulos que ele nao deve alterar nesta sprint). */
export interface FonteRow {
  id: string;
  tipo: string;
  endpoint_base: string;
  ordem: number;
}

export interface ConfigRow {
  janela_dias: number | null;
  data_inicial: string | null;
  recursos: Record<string, unknown> | null;
  modalidades: string[] | null;
  portais: string[] | null;
}

export interface InitialCheckpointArgs {
  modo: CheckpointModo;
  since: Date;
  until: Date;
}

export interface BlockRunDeps {
  /** service_role: escrita server-side contornando RLS (SEC-05). */
  db: SupabaseClient;
  /** Opcional: ausente => itens ficam 'pendente' (sem embeddings). */
  embeddingProvider?: EmbeddingProvider;
  /** Fonte da execucao (id, tipo, endpoint_base). */
  fonte: FonteRow;
  /** Credencial da fonte lida do Vault em runtime. */
  token: string;
  /** config_ingestao da fonte (janela, recursos, filtros). */
  config: ConfigRow | null;
}

export interface BlockRunParams<TCursor> {
  execucaoId: string;
  recurso: string | null;
  checkpoint: CheckpointEnvelope<TCursor>;
  signal?: AbortSignal;
}

export interface BlockRunOutcome<TCursor> {
  estado: "em_andamento" | "concluida" | "erro";
  concluido: boolean;
  checkpoint: CheckpointEnvelope<TCursor>;
  processadosSucesso: number;
  processadosErro: number;
}

/**
 * Adapter de ciclo de vida de UMA fonte coletavel em blocos. Compoe um
 * SourceConnector por dentro (D1). O orquestrador o trata como
 * BlockSourceAdapter<unknown> (type-erasure do cursor).
 */
export interface BlockSourceAdapter<TCursor> {
  readonly tipo: string;

  /** Cursor inicial + envelope de uma nova execucao. */
  buildInitialCheckpoint(args: InitialCheckpointArgs): CheckpointEnvelope<TCursor>;

  /**
   * Valida/normaliza o checkpoint do jsonb. Retorna null quando invalido.
   * Tolerante ao formato legado plano (campos no topo, sem `cursor`).
   */
  parseCheckpoint(raw: unknown): CheckpointEnvelope<TCursor> | null;

  /** Roda UM bloco e reporta `concluido`. Persiste checkpoint nas fronteiras. */
  runBlock(deps: BlockRunDeps, params: BlockRunParams<TCursor>): Promise<BlockRunOutcome<TCursor>>;

  /** Teto de retomadas apos erro (env por fonte). */
  maxRetomadas(): number;

  /** Hook opcional pos-bloco (Effecti: descobrir vinculos). Best-effort. */
  onBlockComplete?(deps: BlockRunDeps, execucaoId: string): Promise<void>;
}

// ---------------------------------------------------------------------
// 5.3 Parse/builder generico do envelope (D2) — computacao PURA (sem I/O)
// ---------------------------------------------------------------------

/**
 * Parse/valida APENAS os campos de ciclo comuns + extrai o blob de cursor
 * (aninhado em `cursor` OU, no formato legado plano, o proprio objeto raw).
 * Retorna null quando o envelope e invalido (sem janela_inicio). Computacao
 * pura — testavel por tabela, sem I/O. Porta a validacao comum hoje em
 * parseCheckpoint (nomus) / parseEffectiCheckpoint (effecti), removendo os
 * campos de cursor.
 */
export function parseEnvelope(
  raw: unknown,
): { envelope: Omit<CheckpointEnvelope<unknown>, "cursor">; cursorRaw: unknown } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const janelaInicio = typeof o.janela_inicio === "string" ? o.janela_inicio : "";
  if (janelaInicio === "") return null;
  const janelaFim = typeof o.janela_fim === "string" && o.janela_fim !== ""
    ? o.janela_fim
    : new Date().toISOString();
  const envelope: Omit<CheckpointEnvelope<unknown>, "cursor"> = {
    janela_inicio: janelaInicio,
    janela_fim: janelaFim,
    fase: o.fase === "concluido" ? "concluido" : "coleta",
    tentativas_retomada: typeof o.tentativas_retomada === "number"
      ? Math.max(0, Math.floor(o.tentativas_retomada))
      : 0,
    modo: o.modo === "backfill" ? "backfill" : "incremental",
  };
  // Tolerancia ao formato legado plano: sem `cursor`, o proprio objeto raw e o
  // blob de cursor (o adapter le os campos de cursor do topo).
  const cursorRaw = (raw as { cursor?: unknown }).cursor ?? raw;
  return { envelope, cursorRaw };
}

/** Monta o envelope comum (cursor preenchido pelo adapter). */
export function buildEnvelope(
  args: InitialCheckpointArgs,
  cursor: unknown,
): CheckpointEnvelope<unknown> {
  return {
    janela_inicio: args.since.toISOString(),
    janela_fim: args.until.toISOString(),
    fase: "coleta",
    tentativas_retomada: 0,
    modo: args.modo,
    cursor,
  };
}

// ---------------------------------------------------------------------
// 5.5 Auto-cura de orfa generica (D3) — heartbeat por updated_at
// ---------------------------------------------------------------------

/**
 * Teto de heartbeat: execucao ativa sem UPDATE (updated_at) por mais que isso
 * => orfa. Calibrado ACIMA do *_BLOCO_MAX_MS (~50s). Substitui o legado
 * EFFECTI_ORPHAN_STALE_MS, mantido como fallback de nome (§7). Default 10 min.
 */
export function blockOrphanStaleMs(): number {
  return envInt("BLOCK_ORPHAN_STALE_MS", envInt("EFFECTI_ORPHAN_STALE_MS", 600_000));
}

/**
 * Decide se uma execucao ativa esta orfa (heartbeat velho). Conservador:
 * updated_at/inicio ilegivel => false (trata como viva, nunca mata run
 * legitimo). Heartbeat = updated_at (fallback inicio), bumpado a cada item.
 */
export function isOrfa(exec: { updated_at?: string | null; inicio: string }): boolean {
  const heartbeatMs = Date.parse(exec.updated_at ?? exec.inicio);
  if (!Number.isFinite(heartbeatMs)) return false;
  return Date.now() - heartbeatMs > blockOrphanStaleMs();
}

/**
 * Fecha a execucao como 'erro' e libera o lock-por-fonte. Idempotente: o guard
 * .eq("status","em_andamento") garante que uma execucao ja curada/avancada nao
 * seja sobrescrita. Loga de forma estruturada (sem rotular a fonte).
 */
export async function autoCurarOrfa(db: SupabaseClient, execucaoId: string): Promise<void> {
  const staleMs = blockOrphanStaleMs();
  const { data, error } = await db
    .from("execucoes")
    .update({ status: "erro", etapa_atual: null, fim: new Date().toISOString() })
    .eq("id", execucaoId)
    .eq("status", "em_andamento")
    .select("updated_at")
    .maybeSingle();
  const updatedAt = data ? (data as { updated_at?: string | null }).updated_at ?? null : null;
  if (error) {
    console.error("[block-source] falha ao auto-curar orfa", {
      execucaoId,
      error: error.message,
    });
    return;
  }
  console.warn("[block-source] orfa auto-curada (heartbeat velho)", {
    execucaoId,
    updatedAt,
    staleMs,
  });
}

// ---------------------------------------------------------------------
// 5.6 Helpers compartilhados (D4) — copia UNICA (byte-a-byte das duplicatas)
// ---------------------------------------------------------------------

/** Contadores acumulados de uma execucao (carregados de execucoes). */
export interface Counters {
  novos: number;
  alterados: number;
  sucesso: number;
  erro: number;
  inicioMs: number;
}

/** Patch parcial de uma linha de execucoes. */
export interface ExecucaoPatch {
  status?: string;
  etapa_atual?: string | null;
  fim?: string;
  duracao?: string;
  checkpoint?: { [k: string]: unknown };
  novos?: number;
  alterados?: number;
  total_processar?: number;
  processados_sucesso?: number;
  processados_erro?: number;
  pendentes?: number;
}

/** Le um inteiro positivo de uma env var, saneando (fallback se ausente/invalida). */
export function envInt(name: string, fallback: number): number {
  let raw: string | undefined;
  try {
    raw = Deno.env.get(name);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Formata milissegundos em duracao legivel (ex.: "1m 23s"). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Janela movel padrao (em dias) a partir de agora. */
export function janelaMovel(janelaDias: number, until: Date = new Date()): Date {
  return new Date(until.getTime() - janelaDias * MS_PER_DAY);
}

/** Carrega os contadores acumulados + inicio de uma execucao. */
export async function loadCounters(db: SupabaseClient, execucaoId: string): Promise<Counters> {
  const { data } = await db
    .from("execucoes")
    .select("novos, alterados, processados_sucesso, processados_erro, inicio")
    .eq("id", execucaoId)
    .maybeSingle();
  const row = (data ?? {}) as {
    novos?: number | null;
    alterados?: number | null;
    processados_sucesso?: number | null;
    processados_erro?: number | null;
    inicio?: string | null;
  };
  const inicioMs = row.inicio ? Date.parse(row.inicio) : Date.now();
  return {
    novos: row.novos ?? 0,
    alterados: row.alterados ?? 0,
    sucesso: row.processados_sucesso ?? 0,
    erro: row.processados_erro ?? 0,
    inicioMs: Number.isFinite(inicioMs) ? inicioMs : Date.now(),
  };
}

/** Aplica um patch parcial numa linha de execucoes (best-effort, loga falha). */
export async function updateExecucao(
  db: SupabaseClient,
  id: string,
  patch: ExecucaoPatch,
): Promise<void> {
  const { error } = await db.from("execucoes").update(patch).eq("id", id);
  if (error) {
    console.error("[block-source] falha ao atualizar execucao", {
      execucaoId: id,
      error: error.message,
    });
  }
}

/**
 * Conclui a execucao (status='concluida', fim/duracao, contadores finais) e
 * carimba fontes.ultima_coleta_em. Falha ao atualizar a fonte e logada, nao
 * interrompe a conclusao.
 */
export async function finalizeConcluida(
  db: SupabaseClient,
  execucaoId: string,
  fonteId: string,
  checkpoint: { [k: string]: unknown },
  counters: Counters,
): Promise<void> {
  const fim = new Date();
  await updateExecucao(db, execucaoId, {
    status: "concluida",
    etapa_atual: null,
    fim: fim.toISOString(),
    duracao: formatDuration(Date.now() - counters.inicioMs),
    checkpoint,
    novos: counters.novos,
    alterados: counters.alterados,
    processados_sucesso: counters.sucesso,
    processados_erro: counters.erro,
  });

  const { error } = await db
    .from("fontes")
    .update({ ultima_coleta_em: fim.toISOString() })
    .eq("id", fonteId);
  if (error) {
    console.error("[block-source] falha ao atualizar fontes.ultima_coleta_em", {
      fonteId,
      error: error.message,
    });
  }
}
