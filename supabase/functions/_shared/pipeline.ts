// =====================================================================
// _shared/pipeline.ts
// Orquestracao assincrona da ingestao item-a-item (US-02/04/05/08/19, RNF-05).
//
// Estado no banco: cada item atualiza execucoes.etapa_atual e os contadores
// (novos/alterados/total_processar/processados_sucesso/processados_erro/
// pendentes); o Realtime de execucoes reflete o progresso ao vivo no front.
//
// Etapas por item: coleta -> tratamento -> indexacao -> persistencia.
//   - coleta:      conector Effecti (paginacao/backoff/sync incremental).
//   - tratamento:  download + extracao verbatim dos arquivos (OCR fallback).
//   - indexacao:   chunking + embeddings plugaveis (bge-m3, vector(1024)).
//   - persistencia: upsert do aviso (dedupe effecti_id) + contadores.
//
// Falha por item e ISOLADA: vira erro do item em erros_ingestao e NAO derruba
// o lote (RNF-05). Falha total (zero itens / erro de coleta) finaliza a
// execucao como 'erro' e dispara notificacao proativa (RF-41).
//
// A mesma pipeline serve a coleta agendada (pg_cron) e sob demanda (RF-06).
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { type CollectedAviso, type SourceConnector } from "./effecti-connector.ts";
import { EmbeddingError, type EmbeddingProvider, generateAndStoreChunks } from "./embeddings.ts";
import { extractFileLinks, processAvisoFiles, type TextExtractor } from "./file-processing.ts";
import { errorMessage, recordIngestErro } from "./ingest-errors.ts";
import { hashTexto } from "./hash.ts";
import { maybeNotifyHealthcheckFalha, notifySyncFailure } from "./notify.ts";
import { captureException } from "./audit.ts";

export type EtapaAtual = "coleta" | "tratamento" | "indexacao" | "persistencia";

export type StatusIndexacao = "pendente" | "em_andamento" | "indexado" | "erro";

export interface PipelineDeps {
  /** Cliente service_role: escrita server-side contornando RLS na coleta. */
  db: SupabaseClient;
  connector: SourceConnector;
  /** Opcional: ausente no v0 (ingestao so dos avisos, sem embeddings). */
  embeddingProvider?: EmbeddingProvider;
  /** Opcional: ausente no v0 (sem download/parse de editais). */
  textExtractor?: TextExtractor;
  fetchImpl?: typeof fetch;
}

export interface PipelineParams {
  execucaoId: string;
  sinceDate: Date;
  modalidades?: string[];
  portais?: string[];
  signal?: AbortSignal;
}

export interface PipelineResult {
  total: number;
  novos: number;
  alterados: number;
  processadosSucesso: number;
  processadosErro: number;
}

interface ExecucaoPatch {
  etapa_atual?: EtapaAtual | null;
  status?: string;
  fim?: string;
  duracao?: string;
  novos?: number;
  alterados?: number;
  total_processar?: number;
  processados_sucesso?: number;
  processados_erro?: number;
  pendentes?: number;
}

/**
 * Executa o pipeline completo de uma execucao. Atualiza estado/contadores no
 * banco a cada item (Realtime) e finaliza a execucao como 'concluida' ou
 * 'erro'. Nunca lanca por falha de item; lanca apenas em falha irrecuperavel
 * de infraestrutura ja refletida na execucao.
 */
export async function runPipeline(
  deps: PipelineDeps,
  params: PipelineParams,
): Promise<PipelineResult> {
  const { db } = deps;
  const startedAtMs = Date.now();
  const result: PipelineResult = {
    total: 0,
    novos: 0,
    alterados: 0,
    processadosSucesso: 0,
    processadosErro: 0,
  };

  // ---- Etapa de coleta: consome o conector (paginacao/backoff) -----------
  await updateExecucao(db, params.execucaoId, { etapa_atual: "coleta" });

  let coletados: CollectedAviso[];
  try {
    coletados = await collectAll(deps.connector, params);
  } catch (err) {
    // Falha total de coleta (ex.: credencial invalida / fonte fora do ar).
    const motivo = errorMessage(err);
    await recordIngestErro(db, {
      execucaoId: params.execucaoId,
      severidade: "alta",
      etapa: "Coleta",
      mensagem: `falha total na coleta: ${motivo}`,
    });
    await finalizeExecucao(db, params.execucaoId, "erro", startedAtMs, result);
    await notifySyncFailure({ execucaoId: params.execucaoId, motivo });
    await captureException(err, {
      scope: "pipeline",
      phase: "coleta",
      execucaoId: params.execucaoId,
    });
    return result;
  }

  result.total = coletados.length;
  await updateExecucao(db, params.execucaoId, {
    total_processar: result.total,
    pendentes: result.total,
    processados_sucesso: 0,
    processados_erro: 0,
  });

  if (coletados.length === 0) {
    // Nenhum item na janela: execucao concluida (sem novidades) e nao e falha.
    await finalizeExecucao(db, params.execucaoId, "concluida", startedAtMs, result);
    return result;
  }

  // ---- Processamento item a item -----------------------------------------
  for (const aviso of coletados) {
    if (params.signal?.aborted) break;

    try {
      const { avisoId, status } = await persistAvisoBase(db, aviso, params.execucaoId);
      if (status === "novo") result.novos += 1;
      else if (status === "alterado") result.alterados += 1;
      // status === "ignorado" (hash igual) ou legado (hash NULL populado): nao
      // conta como alterado -> espelha o Nomus, evita inflar ALTERADOS a cada ciclo.

      // Tratamento de arquivos (download + extracao verbatim, OCR fallback).
      // Etapa OPCIONAL: so roda quando ha extrator configurado. No v0 ingere-se
      // apenas os avisos; o parse de editais e fase futura.
      if (deps.textExtractor) {
        await updateExecucao(db, params.execucaoId, { etapa_atual: "tratamento" });
        const files = extractFileLinks(aviso.payloadBruto);
        if (files.length > 0) {
          await processAvisoFiles(db, {
            avisoId,
            execucaoId: params.execucaoId,
            files,
            extractor: deps.textExtractor,
            fetchImpl: deps.fetchImpl,
            signal: params.signal,
          });
        }
      }

      // Indexacao: chunking + embeddings do verbatim integro.
      // Etapa OPCIONAL: so roda quando ha provider de embeddings configurado.
      // Sem provider, o aviso permanece status_indexacao='pendente' para ser
      // indexado numa fase posterior, sem travar a ingestao do aviso.
      if (deps.embeddingProvider) {
        await updateExecucao(db, params.execucaoId, { etapa_atual: "indexacao" });
        await setStatusIndexacao(db, avisoId, "em_andamento");
        await generateAndStoreChunks(
          db,
          { avisoId, verbatim: aviso.conteudoVerbatim, provider: deps.embeddingProvider },
          { signal: params.signal },
        );
        await setStatusIndexacao(db, avisoId, "indexado");
      }

      // Persistencia: contadores do item concluido.
      result.processadosSucesso += 1;
      await updateExecucao(db, params.execucaoId, {
        etapa_atual: "persistencia",
        novos: result.novos,
        alterados: result.alterados,
        processados_sucesso: result.processadosSucesso,
        processados_erro: result.processadosErro,
        pendentes: result.total - result.processadosSucesso - result.processadosErro,
      });
    } catch (err) {
      // Falha isolada do item: registra e segue (RNF-05).
      result.processadosErro += 1;
      const etapa = err instanceof EmbeddingError ? "Indexacao" : "Tratamento";
      await recordIngestErro(db, {
        execucaoId: params.execucaoId,
        avisoId: await resolveAvisoId(db, aviso.effectiId),
        severidade: "media",
        etapa,
        mensagem: `falha ao processar aviso ${aviso.effectiId}: ${errorMessage(err)}`,
      });
      await updateExecucao(db, params.execucaoId, {
        processados_sucesso: result.processadosSucesso,
        processados_erro: result.processadosErro,
        pendentes: result.total - result.processadosSucesso - result.processadosErro,
      });
    }
  }

  await finalizeExecucao(db, params.execucaoId, "concluida", startedAtMs, result);

  // Estado parado pos-execucao dispara alerta proativo (RF-41).
  await maybeNotifyHealthcheckFalha(db);

  return result;
}

// ---------------------------------------------------------------------
// Coleta: materializa o gerador do conector (necessario p/ total_processar)
// ---------------------------------------------------------------------

async function collectAll(
  connector: SourceConnector,
  params: PipelineParams,
): Promise<CollectedAviso[]> {
  const items: CollectedAviso[] = [];
  for await (
    const aviso of connector.collect({
      sinceDate: params.sinceDate,
      modalidades: params.modalidades,
      portais: params.portais,
      signal: params.signal,
    })
  ) {
    items.push(aviso);
  }
  return items;
}

// ---------------------------------------------------------------------
// Persistencia do aviso base (upsert com dedupe por effecti_id)
// ---------------------------------------------------------------------

type PersistStatus = "novo" | "alterado" | "ignorado";

async function persistAvisoBase(
  db: SupabaseClient,
  aviso: CollectedAviso,
  execucaoId: string,
): Promise<{ avisoId: string; status: PersistStatus }> {
  const { data: existing, error: selError } = await db
    .from("avisos")
    .select("id, conteudo_hash")
    .eq("effecti_id", aviso.effectiId)
    .maybeSingle();

  if (selError) {
    throw new Error(`falha ao consultar aviso existente: ${selError.message}`);
  }

  // Hash dos campos de negocio NORMALIZADOS (espelha o Nomus). NUNCA do
  // payload bruto: ele carrega campos volateis por fetch (dataCaptura,
  // favorito, naLixeira, rankingCapag) + chaves reordenadas pelo Postgres ->
  // o hash nunca baterea e tudo viraria 'alterado'. So conta 'alterado'
  // quando um campo de negocio muda de verdade.
  const hash = hashAvisoCanonico(aviso);

  if (existing) {
    const persistido = (existing as { conteudo_hash: string | null }).conteudo_hash ?? null;
    const avisoId = String((existing as { id: string }).id);
    // Hash igual: nada mudou -> nao reescreve, nao conta (ignorado).
    if (persistido === hash) {
      return { avisoId, status: "ignorado" };
    }
    // Legado (hash NULL): 1a coleta apos o deploy popula o hash SEM contar como
    // alterado (evita falso pico de 'alterados' na estabilizacao).
    const status: PersistStatus = persistido === null ? "ignorado" : "alterado";
    const row = buildRow(aviso, execucaoId, hash);
    const { error: upError } = await db
      .from("avisos")
      .update(row)
      .eq("id", avisoId);
    if (upError) {
      throw new Error(`falha ao atualizar aviso: ${upError.message}`);
    }
    return { avisoId, status };
  }

  const row = buildRow(aviso, execucaoId, hash);
  const { data, error: upError } = await db
    .from("avisos")
    .insert(row)
    .select("id")
    .single();

  if (upError || !data) {
    throw new Error(`falha ao persistir aviso: ${upError?.message ?? "sem id"}`);
  }

  return { avisoId: String((data as { id: string }).id), status: "novo" };
}

// Separador estavel entre campos (ASCII Unit Separator), igual ao hash.ts.
const CANONICO_SEP = "\u001f";

/**
 * Hash canonico do aviso a partir dos campos de negocio JA normalizados pelo
 * conector (ordem fixa). Exclui dataCaptura e o payload bruto (volateis) para
 * que re-coletar um aviso inalterado produza o MESMO hash.
 */
function hashAvisoCanonico(aviso: CollectedAviso): string {
  const canonical = [
    aviso.modalidade ?? "",
    aviso.orgao ?? "",
    aviso.objeto ?? "",
    aviso.portal ?? "",
    aviso.conteudoVerbatim ?? "",
    aviso.dataPublicacao ?? "",
    aviso.dataInicial ?? "",
    aviso.dataFinal ?? "",
  ].join(CANONICO_SEP);
  return hashTexto(canonical);
}

function buildRow(aviso: CollectedAviso, execucaoId: string, hash: string) {
  return {
    effecti_id: aviso.effectiId,
    modalidade: aviso.modalidade,
    orgao: aviso.orgao,
    objeto: aviso.objeto,
    portal: aviso.portal,
    conteudo_verbatim: aviso.conteudoVerbatim,
    payload_bruto: aviso.payloadBruto,
    conteudo_hash: hash,
    data_captura: aviso.dataCaptura,
    data_publicacao: aviso.dataPublicacao,
    data_inicial: aviso.dataInicial,
    data_final: aviso.dataFinal,
    origem: aviso.origem,
    execucao_origem_id: execucaoId,
    status_indexacao: "pendente" as StatusIndexacao,
  };
}

async function resolveAvisoId(db: SupabaseClient, effectiId: string): Promise<string | null> {
  const { data } = await db
    .from("avisos")
    .select("id")
    .eq("effecti_id", effectiId)
    .maybeSingle();
  return data ? String((data as { id: string }).id) : null;
}

async function setStatusIndexacao(
  db: SupabaseClient,
  avisoId: string,
  status: StatusIndexacao,
): Promise<void> {
  const { error } = await db
    .from("avisos")
    .update({ status_indexacao: status })
    .eq("id", avisoId);
  if (error) {
    // Status de indexacao e secundario; nao derruba o item por isso.
    console.error("[pipeline] falha ao atualizar status_indexacao", {
      avisoId,
      status,
      error: error.message,
    });
  }
}

// ---------------------------------------------------------------------
// Atualizacao de estado da execucao
// ---------------------------------------------------------------------

async function updateExecucao(
  db: SupabaseClient,
  execucaoId: string,
  patch: ExecucaoPatch,
): Promise<void> {
  const { error } = await db.from("execucoes").update(patch).eq("id", execucaoId);
  if (error) {
    console.error("[pipeline] falha ao atualizar execucao", {
      execucaoId,
      error: error.message,
    });
  }
}

async function finalizeExecucao(
  db: SupabaseClient,
  execucaoId: string,
  status: "concluida" | "erro",
  startedAtMs: number,
  result: PipelineResult,
): Promise<void> {
  const fim = new Date();
  await updateExecucao(db, execucaoId, {
    etapa_atual: null,
    status,
    fim: fim.toISOString(),
    duracao: formatDuration(Date.now() - startedAtMs),
    novos: result.novos,
    alterados: result.alterados,
    total_processar: result.total,
    processados_sucesso: result.processadosSucesso,
    processados_erro: result.processadosErro,
    pendentes: Math.max(0, result.total - result.processadosSucesso - result.processadosErro),
  });
}

/** Formata milissegundos em duracao legivel (ex.: "1m 23s"). */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
