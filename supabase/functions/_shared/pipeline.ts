// =====================================================================
// _shared/pipeline.ts
// Orquestracao assincrona da ingestao item-a-item (US-02/04/05/08/19, RNF-05).
//
// Estado no banco: cada item atualiza execucoes.etapa_atual e os contadores
// (novos/alterados/total_processar/processados_sucesso/processados_erro/
// pendentes); o Realtime de execucoes reflete o progresso ao vivo no front.
//
// Etapas por item: coleta -> indexacao -> persistencia.
//   - coleta:      conector Effecti (paginacao/backoff/sync incremental).
//   - indexacao:   chunking + embeddings plugaveis (bge-m3, vector(1024)).
//   - persistencia: upsert do aviso (dedupe effecti_id) + contadores.
//
// A etapa de tratamento (download + extracao verbatim de arquivos) foi
// APOSENTADA da pipeline do Edge: a extracao de documentos migrou para o
// pipeline proprio (Tika no runner), seguindo a decisao de NAO guardar binario.
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
      const { avisoId, status, reindexar } = await persistAvisoBase(db, aviso, params.execucaoId);
      if (status === "novo") result.novos += 1;
      else if (status === "alterado") result.alterados += 1;
      // status === "ignorado" (hash igual) ou legado (hash NULL populado): nao
      // conta como alterado -> espelha o Nomus, evita inflar ALTERADOS a cada ciclo.

      // Indexacao: chunking + embeddings do verbatim integro.
      // Etapa OPCIONAL: so roda quando ha provider de embeddings configurado E o
      // verbatim mudou (reindexar). Sem provider, o aviso permanece
      // status_indexacao='pendente' para indexacao posterior, sem travar a ingestao.
      if (deps.embeddingProvider && reindexar) {
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
  // Dedupe por effecti_id: a paginacao do Effecti as vezes repete um registro
  // entre paginas. Sem dedupe, a mesma ocorrencia conta 2x em novos/alterados
  // (so 1 linha persiste por effecti_id). Map mantem a ULTIMA ocorrencia ->
  // contador 100% fiel as linhas distintas.
  const porId = new Map<string, CollectedAviso>();
  for await (
    const aviso of connector.collect({
      sinceDate: params.sinceDate,
      modalidades: params.modalidades,
      portais: params.portais,
      signal: params.signal,
    })
  ) {
    porId.set(aviso.effectiId, aviso);
  }
  return [...porId.values()];
}

// ---------------------------------------------------------------------
// Persistencia do aviso base (upsert com dedupe por effecti_id)
// ---------------------------------------------------------------------

export type PersistStatus = "novo" | "alterado" | "ignorado";

export interface PersistResult {
  avisoId: string;
  status: PersistStatus;
  reindexar: boolean;
  /** Estado final do favorito da linha (OR das ocorrencias da run). */
  favorito: boolean;
  /** Se o favorito desta linha JA foi propagado (write-back) para a Effecti.
   *  O caller (write-back) so propaga quando favorito===true && !favoritoPropagado. */
  favoritoPropagado: boolean;
}

export async function persistAvisoBase(
  db: SupabaseClient,
  aviso: CollectedAviso,
  execucaoId: string,
): Promise<PersistResult> {
  const { data: existing, error: selError } = await db
    .from("avisos")
    .select(
      "id, conteudo_hash, conteudo_verbatim, execucao_origem_id, favorito, favorito_propagado, data_captura",
    )
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
    const row = existing as {
      id: string;
      conteudo_hash: string | null;
      conteudo_verbatim: string | null;
      execucao_origem_id: string | null;
      favorito: boolean | null;
      favorito_propagado: boolean | null;
      data_captura: string | null;
    };
    const persistido = row.conteudo_hash ?? null;
    const avisoId = String(row.id);

    // FAVORITO = OR de todas as ocorrencias do id na coleta. A MESMA licitacao gera
    // N avisos (re-servico de paginacao + eventos/comunicados distintos), com favorito
    // POR OCORRENCIA. A 1a ocorrencia da run reseta a base (estado atual da Effecti ->
    // permite DESMARCAR entre coletas); reocorrencias so SOBEM (nunca rebaixam dentro
    // da run). Compartilha o mesmo execucaoId atraves dos blocos/ticks da coleta.
    const primeiraDaRun = row.execucao_origem_id !== execucaoId;
    const favoritoFinal = primeiraDaRun
      ? aviso.favorito === true
      : row.favorito === true || aviso.favorito === true;

    // Write-back: o caller propaga (PUT favoritar-licitacao) quando favoritoFinal
    // vira true e ainda nao foi propagado. Quando o favorito CAI para false, reseta
    // a flag para que um eventual re-favoritar volte a propagar.
    const jaPropagado = row.favorito_propagado === true;
    const resetPropagado = favoritoFinal === false && jaPropagado;

    // EVENTO MAIS RECENTE VENCE P/ CONTEUDO. dataCaptura discrimina o EVENTO: o
    // re-servico de paginacao do MESMO evento mantem a dataCaptura (nunca "mais
    // recente" -> nao reescreve -> mata o auto-flip dos 'alterados'); um evento/
    // comunicado novo (ex "licitacao deserta") traz dataCaptura MAIOR -> a linha unica
    // do idLicitacao passa a refletir o aviso mais atual. Uma linha por licitacao:
    // comunicados sao atualizacoes da mesma licitacao, nunca novas linhas.
    const dcNovo = aviso.dataCaptura ? new Date(aviso.dataCaptura).getTime() : NaN;
    const dcAtual = row.data_captura ? new Date(row.data_captura).getTime() : NaN;
    const maisRecente = !Number.isFinite(dcAtual) ||
      (Number.isFinite(dcNovo) && dcNovo > dcAtual);

    if (maisRecente) {
      // Reescreve o conteudo com o evento mais recente. So conta 'alterado' quando um
      // campo de NEGOCIO mudou de verdade (hash != persistido). Legado (hash NULL) so
      // popula sem contar como alterado (evita falso pico na estabilizacao). So
      // re-embed quando o verbatim (texto que vira vetor) muda.
      const status: PersistStatus = persistido !== null && persistido !== hash
        ? "alterado"
        : "ignorado";
      const reindexar = (row.conteudo_verbatim ?? "") !== (aviso.conteudoVerbatim ?? "");
      const updateRow = {
        ...buildRow(aviso, execucaoId, hash, reindexar, favoritoFinal),
        ...(resetPropagado ? { favorito_propagado: false } : {}),
      };
      const { error: upError } = await db
        .from("avisos")
        .update(updateRow)
        .eq("id", avisoId);
      if (upError) {
        throw new Error(`falha ao atualizar aviso: ${upError.message}`);
      }
      return {
        avisoId,
        status,
        reindexar,
        favorito: favoritoFinal,
        favoritoPropagado: resetPropagado ? false : jaPropagado,
      };
    }

    // Evento mais antigo OU re-servico do mesmo evento (dataCaptura <= atual): NAO
    // toca o conteudo (a linha ja reflete o evento mais recente), mas CARIMBA a
    // execucao (dedup/OR cross-tick) e sincroniza o favorito (reset na 1a ocorrencia,
    // OR nas seguintes). na_lixeira so espelha na 1a ocorrencia da run (sem OR).
    const stamp: {
      execucao_origem_id: string;
      favorito: boolean;
      na_lixeira?: boolean | null;
      favorito_propagado?: boolean;
    } = { execucao_origem_id: execucaoId, favorito: favoritoFinal };
    if (primeiraDaRun) {
      stamp.na_lixeira = aviso.naLixeira;
    }
    if (resetPropagado) {
      stamp.favorito_propagado = false;
    }
    const { error: stampError } = await db
      .from("avisos")
      .update(stamp)
      .eq("id", avisoId);
    if (stampError) {
      throw new Error(`falha ao carimbar execucao no aviso: ${stampError.message}`);
    }
    return {
      avisoId,
      status: "ignorado",
      reindexar: false,
      favorito: favoritoFinal,
      favoritoPropagado: resetPropagado ? false : jaPropagado,
    };
  }

  const favoritoNovo = aviso.favorito === true;
  const row = buildRow(aviso, execucaoId, hash, true, favoritoNovo);
  const { data, error: upError } = await db
    .from("avisos")
    .insert(row)
    .select("id")
    .single();

  if (upError || !data) {
    throw new Error(`falha ao persistir aviso: ${upError?.message ?? "sem id"}`);
  }

  // Aviso novo: favorito_propagado tem default false -> se favorito, o caller propaga.
  return {
    avisoId: String((data as { id: string }).id),
    status: "novo",
    reindexar: true,
    favorito: favoritoNovo,
    favoritoPropagado: false,
  };
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

function buildRow(
  aviso: CollectedAviso,
  execucaoId: string,
  hash: string,
  reindexar: boolean,
  favorito: boolean,
) {
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
    // Espelho do estado na Effecti (so leitura). Fora do hash canonico de
    // proposito: mudar favorito NAO conta como 'alterado'. Recebe o favoritoFinal
    // (OR das ocorrencias da run), nao o valor cru da ocorrencia.
    favorito,
    na_lixeira: aviso.naLixeira,
    execucao_origem_id: execucaoId,
    // So re-marca para indexar quando o verbatim mudou. Update so de data
    // preserva o status_indexacao atual (nao re-enfileira embedding em vao).
    ...(reindexar ? { status_indexacao: "pendente" as StatusIndexacao } : {}),
  };
}

export async function resolveAvisoId(db: SupabaseClient, effectiId: string): Promise<string | null> {
  const { data } = await db
    .from("avisos")
    .select("id")
    .eq("effecti_id", effectiId)
    .maybeSingle();
  return data ? String((data as { id: string }).id) : null;
}

export async function setStatusIndexacao(
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
