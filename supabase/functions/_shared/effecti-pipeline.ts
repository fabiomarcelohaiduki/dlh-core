// =====================================================================
// _shared/effecti-pipeline.ts
// Processamento da coleta Effecti em BLOCOS com checkpoint (espelha o
// nomus-pipeline). Motivacao: a API Effecti limita cada consulta a 5 dias e
// uma janela grande (ex.: 30 dias) gera milhares de avisos sequenciais que NAO
// cabem num unico waitUntil do Edge Runtime (o processo morre no meio, deixando
// a execucao 'em_andamento' orfa e travando o lock-por-fonte). A solucao e
// avancar UM bloco por tique do orquestrador, salvando o cursor.
//
// Checkpoint de DOIS NIVEIS (diferenca para o Nomus, que tem so pagina):
//   - bloco_inicio: inicio do bloco de <= 5 dias corrente (limite da API).
//   - pagina_atual: pagina 0-indexed DENTRO do bloco (Effecti e 0-indexed).
// Ao esgotar um bloco (pagina vazia / sem mais paginas), avanca 5 dias e
// reinicia a paginacao; conclui quando bloco_inicio alcanca janela_fim.
//
// Reaproveita a persistencia/indexacao do pipeline Effecti (persistAvisoBase +
// generateAndStoreChunks), com isolamento de falha por item (RNF-05). Toda
// escrita usa service_role server-side (SEC-05).
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import {
  type CollectedAviso,
  type EffectiConnector,
} from "./effecti-connector.ts";
import { EmbeddingError, type EmbeddingProvider, generateAndStoreChunks } from "./embeddings.ts";
import { persistAvisoBase, resolveAvisoId, setStatusIndexacao } from "./pipeline.ts";
import { errorMessage, recordIngestErro } from "./ingest-errors.ts";
import { captureException } from "./audit.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Janela maxima por consulta da API Effecti (mesmo limite do conector). */
const MAX_WINDOW_DAYS = 5;

// ---------------------------------------------------------------------
// Checkpoint (execucoes.checkpoint jsonb)
// ---------------------------------------------------------------------

export type EffectiCheckpointFase = "coleta" | "concluido";

export interface EffectiCheckpoint {
  /** Inicio do bloco de <= 5 dias corrente (ISO-8601). */
  bloco_inicio: string;
  /** Proxima pagina a coletar DENTRO do bloco (0-indexed). */
  pagina_atual: number;
  /** Limite inferior global da janela (ISO-8601). */
  janela_inicio: string;
  /** Limite superior global da janela (ISO-8601). */
  janela_fim: string;
  /** Fase corrente da execucao. */
  fase: EffectiCheckpointFase;
  /** Tentativas de retomada apos erro (teto EFFECTI_MAX_RETOMADAS). */
  tentativas_retomada: number;
}

/** Monta o checkpoint inicial de uma nova coleta Effecti. */
export function buildInitialEffectiCheckpoint(since: Date, until: Date): EffectiCheckpoint {
  return {
    bloco_inicio: since.toISOString(),
    pagina_atual: 0,
    janela_inicio: since.toISOString(),
    janela_fim: until.toISOString(),
    fase: "coleta",
    tentativas_retomada: 0,
  };
}

/**
 * Valida/normaliza um checkpoint Effecti vindo do banco (jsonb). Retorna null
 * quando invalido. O campo `bloco_inicio` e EXCLUSIVO do Effecti: um checkpoint
 * Nomus (sem bloco_inicio) ou uma execucao legada sem checkpoint retornam null
 * -> nao sao retomadas/avancadas por este pipeline.
 */
export function parseEffectiCheckpoint(raw: unknown): EffectiCheckpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const blocoInicio = typeof o.bloco_inicio === "string" ? o.bloco_inicio : "";
  const janelaInicio = typeof o.janela_inicio === "string" ? o.janela_inicio : "";
  const pagina = typeof o.pagina_atual === "number" ? o.pagina_atual : NaN;
  if (blocoInicio === "" || janelaInicio === "" || !Number.isFinite(pagina) || pagina < 0) {
    return null;
  }
  const janelaFim = typeof o.janela_fim === "string" && o.janela_fim !== ""
    ? o.janela_fim
    : new Date().toISOString();
  return {
    bloco_inicio: blocoInicio,
    pagina_atual: Math.floor(pagina),
    janela_inicio: janelaInicio,
    janela_fim: janelaFim,
    fase: o.fase === "concluido" ? "concluido" : "coleta",
    tentativas_retomada: typeof o.tentativas_retomada === "number"
      ? Math.max(0, Math.floor(o.tentativas_retomada))
      : 0,
  };
}

// ---------------------------------------------------------------------
// Tuning por env (mesmo PADRAO do nomus-pipeline)
// ---------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
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

export function effectiBlocoMaxPaginas(): number {
  return envInt("EFFECTI_BLOCO_MAX_PAGINAS", 10);
}

export function effectiBlocoMaxMs(): number {
  return envInt("EFFECTI_BLOCO_MAX_MS", 50_000);
}

export function effectiMaxRetomadas(): number {
  return envInt("EFFECTI_MAX_RETOMADAS", 3);
}

// ---------------------------------------------------------------------
// Processamento de UM bloco de paginas (checkpoint/retomada)
// ---------------------------------------------------------------------

export interface EffectiBlockDeps {
  /** service_role: escrita server-side contornando RLS (SEC-05). */
  db: SupabaseClient;
  connector: EffectiConnector;
  /** Opcional: ausente => itens ficam 'pendente' (sem embeddings). */
  embeddingProvider?: EmbeddingProvider;
  /** Fonte da execucao (para atualizar fontes.ultima_coleta_em ao concluir). */
  fonteId: string;
}

export interface EffectiBlockParams {
  execucaoId: string;
  checkpoint: EffectiCheckpoint;
  modalidades?: string[];
  portais?: string[];
  signal?: AbortSignal;
}

export interface EffectiBlockOutcome {
  estado: "em_andamento" | "concluida" | "erro";
  concluido: boolean;
  checkpoint: EffectiCheckpoint;
  processadosSucesso: number;
  processadosErro: number;
}

interface Counters {
  novos: number;
  alterados: number;
  sucesso: number;
  erro: number;
  inicioMs: number;
}

/**
 * Processa UM bloco de paginas a partir do cursor (bloco_inicio, pagina_atual),
 * encerrando por teto de paginas (EFFECTI_BLOCO_MAX_PAGINAS) ou tempo
 * (EFFECTI_BLOCO_MAX_MS). Salva o checkpoint apos cada pagina (heartbeat +
 * Realtime). Avanca 5 dias quando o bloco esgota e conclui quando alcanca
 * janela_fim; falha de infra -> 'erro' preservando o checkpoint para retomada.
 */
export async function runEffectiBlock(
  deps: EffectiBlockDeps,
  params: EffectiBlockParams,
): Promise<EffectiBlockOutcome> {
  const { db, connector, embeddingProvider, fonteId } = deps;
  const { execucaoId, modalidades, portais } = params;
  const checkpoint: EffectiCheckpoint = { ...params.checkpoint };

  const maxPaginas = effectiBlocoMaxPaginas();
  const maxMs = effectiBlocoMaxMs();
  const startMs = Date.now();

  const counters = await loadCounters(db, execucaoId);
  const until = checkpoint.janela_fim ? new Date(checkpoint.janela_fim) : new Date();

  // Write-back de favorito: ids cujo favorito virou true e ainda nao foi
  // propagado para a Effecti nesta coleta. Acumulam ao longo do bloco e sao
  // disparados em batch (PUT favoritar-licitacao) ao encerrar (best-effort).
  const propagarIds = new Set<number>();

  await updateExecucao(db, execucaoId, {
    status: "em_andamento",
    etapa_atual: "coleta",
    checkpoint,
  });

  let paginasNoBloco = 0;

  try {
    while (true) {
      if (params.signal?.aborted) break;
      if (paginasNoBloco >= maxPaginas) break;
      if (Date.now() - startMs >= maxMs) break;

      const blocoInicio = new Date(checkpoint.bloco_inicio);

      // Fim global alcancado: conclui a execucao.
      if (blocoInicio.getTime() >= until.getTime()) {
        checkpoint.fase = "concluido";
        await flushFavoritos(deps, propagarIds, params.signal);
        await finalizeConcluida(db, execucaoId, fonteId, checkpoint, counters);
        return {
          estado: "concluida",
          concluido: true,
          checkpoint,
          processadosSucesso: counters.sucesso,
          processadosErro: counters.erro,
        };
      }

      const blocoFim = new Date(
        Math.min(blocoInicio.getTime() + MAX_WINDOW_DAYS * MS_PER_DAY, until.getTime()),
      );

      const page = await connector.collectPage(blocoInicio, blocoFim, checkpoint.pagina_atual, {
        modalidades,
        portais,
        signal: params.signal,
      });

      for (const aviso of page.items) {
        if (params.signal?.aborted) break;
        try {
          await processAviso(
            db,
            execucaoId,
            aviso,
            embeddingProvider,
            counters,
            propagarIds,
            params.signal,
          );
        } catch (err) {
          // Falha isolada do item: registra e segue (RNF-05).
          counters.erro += 1;
          const etapa = err instanceof EmbeddingError ? "Indexacao" : "Tratamento";
          await recordIngestErro(db, {
            execucaoId,
            avisoId: await resolveAvisoId(db, aviso.effectiId),
            severidade: "media",
            etapa,
            mensagem: `falha ao processar aviso ${aviso.effectiId}: ${errorMessage(err)}`,
          });
        }
      }

      // Bloco esgotado (pagina vazia ou sem mais paginas): avanca 5 dias e
      // reinicia a paginacao. Senao, proxima pagina do mesmo bloco.
      if (page.items.length === 0 || !page.hasMore) {
        checkpoint.bloco_inicio = new Date(blocoFim.getTime() + 1000).toISOString();
        checkpoint.pagina_atual = 0;
      } else {
        checkpoint.pagina_atual += 1;
      }
      paginasNoBloco += 1;

      await updateExecucao(db, execucaoId, {
        checkpoint,
        novos: counters.novos,
        alterados: counters.alterados,
        processados_sucesso: counters.sucesso,
        processados_erro: counters.erro,
      });
    }

    // Bloco de trabalho encerrado por teto (ainda ha janela): propaga os
    // favoritos acumulados (best-effort) e permanece em_andamento com o
    // checkpoint salvo, para o orquestrador retomar.
    await flushFavoritos(deps, propagarIds, params.signal);
    await updateExecucao(db, execucaoId, {
      status: "em_andamento",
      checkpoint,
      novos: counters.novos,
      alterados: counters.alterados,
      processados_sucesso: counters.sucesso,
      processados_erro: counters.erro,
    });
    return {
      estado: "em_andamento",
      concluido: false,
      checkpoint,
      processadosSucesso: counters.sucesso,
      processadosErro: counters.erro,
    };
  } catch (err) {
    // Falha de infra (coleta caiu / fonte fora do ar): estado 'erro'
    // PRESERVANDO o checkpoint para retomada automatica (ate o teto).
    await recordIngestErro(db, {
      execucaoId,
      severidade: "alta",
      etapa: "Coleta",
      mensagem: `falha de coleta Effecti: ${errorMessage(err)}`,
    });
    await updateExecucao(db, execucaoId, {
      status: "erro",
      etapa_atual: null,
      checkpoint,
      novos: counters.novos,
      alterados: counters.alterados,
      processados_sucesso: counters.sucesso,
      processados_erro: counters.erro,
    });
    await captureException(err, { scope: "effecti-pipeline", phase: "bloco", execucaoId });
    return {
      estado: "erro",
      concluido: false,
      checkpoint,
      processadosSucesso: counters.sucesso,
      processadosErro: counters.erro,
    };
  }
}

/**
 * Persiste + indexa UM aviso (espelha o miolo do for-loop do runPipeline).
 * Atualiza os contadores in-place. Lanca em falha (capturada pelo bloco).
 */
async function processAviso(
  db: SupabaseClient,
  execucaoId: string,
  aviso: CollectedAviso,
  embeddingProvider: EmbeddingProvider | undefined,
  counters: Counters,
  propagarIds: Set<number>,
  signal?: AbortSignal,
): Promise<void> {
  const { avisoId, status, reindexar, favorito, favoritoPropagado } = await persistAvisoBase(
    db,
    aviso,
    execucaoId,
  );
  if (status === "novo") counters.novos += 1;
  else if (status === "alterado") counters.alterados += 1;
  // "ignorado" / legado: nao conta (espelha o Nomus).

  // Write-back: enfileira para propagar o favorito a TODAS as ocorrencias do id
  // na Effecti quando virou true e ainda nao foi propagado. idLicitacao e numero.
  if (favorito && !favoritoPropagado) {
    const idNum = Number(aviso.effectiId);
    if (Number.isFinite(idNum)) propagarIds.add(idNum);
  }

  // Indexacao opcional: so quando ha provider de embeddings E o verbatim mudou
  // (reindexar). Flip so de data nao muda o vetor -> nao re-embed.
  if (embeddingProvider && reindexar) {
    await setStatusIndexacao(db, avisoId, "em_andamento");
    await generateAndStoreChunks(
      db,
      { avisoId, verbatim: aviso.conteudoVerbatim, provider: embeddingProvider },
      { signal },
    );
    await setStatusIndexacao(db, avisoId, "indexado");
  }

  counters.sucesso += 1;
}

/**
 * Propaga em BATCH o favorito para a Effecti (PUT favoritar-licitacao) e, se
 * a API confirmar (200), marca favorito_propagado=true nas linhas para nao
 * re-disparar a cada coleta. BEST-EFFORT: falha da API ou do update NAO derruba
 * o bloco; a flag permanece false e o write-back e tentado de novo na proxima
 * coleta. Esvazia o set apos sucesso completo.
 */
async function flushFavoritos(
  deps: EffectiBlockDeps,
  propagarIds: Set<number>,
  signal?: AbortSignal,
): Promise<void> {
  if (propagarIds.size === 0) return;
  const lista = [...propagarIds];

  const ok = await deps.connector.favoritarLicitacao(lista, signal);
  if (!ok) return; // mantem flag false -> re-tenta na proxima coleta.

  const { error } = await deps.db
    .from("avisos")
    .update({ favorito_propagado: true })
    .in("effecti_id", lista.map(String));
  if (error) {
    // Favorito ja foi propagado na Effecti, mas a flag nao foi marcada: a
    // proxima coleta re-propaga (idempotente -> seguro). Apenas loga.
    console.error("[effecti-pipeline] favorito propagado mas falha ao marcar flag", {
      error: error.message,
    });
    return;
  }
  propagarIds.clear();
}

// ---------------------------------------------------------------------
// Helpers de estado / execucao
// ---------------------------------------------------------------------

interface ExecucaoPatch {
  status?: string;
  etapa_atual?: string | null;
  fim?: string;
  duracao?: string;
  checkpoint?: EffectiCheckpoint;
  novos?: number;
  alterados?: number;
  processados_sucesso?: number;
  processados_erro?: number;
}

async function loadCounters(db: SupabaseClient, execucaoId: string): Promise<Counters> {
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

async function finalizeConcluida(
  db: SupabaseClient,
  execucaoId: string,
  fonteId: string,
  checkpoint: EffectiCheckpoint,
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
    console.error("[effecti-pipeline] falha ao atualizar fontes.ultima_coleta_em", {
      fonteId,
      error: error.message,
    });
  }
}

async function updateExecucao(
  db: SupabaseClient,
  execucaoId: string,
  patch: ExecucaoPatch,
): Promise<void> {
  const { error } = await db.from("execucoes").update(patch).eq("id", execucaoId);
  if (error) {
    console.error("[effecti-pipeline] falha ao atualizar execucao", {
      execucaoId,
      error: error.message,
    });
  }
}

/** Formata milissegundos em duracao legivel (ex.: "1m 23s"). */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
