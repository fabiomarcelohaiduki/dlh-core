// =====================================================================
// _shared/nomus-pipeline.ts
// Pipeline de persistencia e indexacao do Nomus (US-08/US-10, RF-15/RF-19).
//
// Reaproveita o PADRAO do pipeline Effecti (persistencia com dedup, decisao
// de reindexacao, isolamento de falha por item) com CONTRATO DE DADOS PROPRIO
// do Nomus (CollectedRecord -> nomus_processos / memoria_chunks).
//
// Caracteristicas:
//   - Dedup por nomus_id (upsert onConflict=nomus_id). empresa NAO compoe a
//     dedup (US-08). payload_bruto preservado verbatim, nunca mutado (SEC-08).
//   - Decisao de reindexacao por hash do conteudo canonico (descricao+nome+
//     etapa): difere -> reindexa (status_indexacao='pendente'); igual -> nao
//     reindexa (US-10/RF-19).
//   - Indexacao idempotente em memoria_chunks (origem='processo'): limpa os
//     chunks do registro antes de regravar (DD-01). bge-m3, vector(1024).
//   - Falha de um item vira linha em erros_ingestao (origem/recurso/registro_id,
//     SEM payload - SEC-09) e o lote CONTINUA (RNF-05).
//   - Processamento em BLOCOS com checkpoint (RF-20): runNomusBlock avanca
//     pagina a pagina de checkpoint.pagina_atual, encerrando por teto de
//     paginas (NOMUS_BLOCO_MAX_PAGINAS) ou tempo (NOMUS_BLOCO_MAX_MS).
//
// Toda escrita usa service_role server-side (SEC-05). NUNCA usa Claude na
// ingestao (embeddings bge-m3 self-hosted, RNF-04).
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { type CollectedPessoa, type CollectedRecord } from "./collected.ts";
import { type NomusConnector } from "./nomus-connector.ts";
import {
  EmbeddingError,
  type EmbeddingProvider,
  generateAndStoreMemoriaChunks,
} from "./embeddings.ts";
import { hashConteudoCanonico, hashTexto } from "./hash.ts";
import { envInt, finalizeConcluida, loadCounters, updateExecucao } from "./block-source.ts";
import { errorMessage, recordIngestErro } from "./ingest-errors.ts";
import { captureException } from "./audit.ts";

// Re-export do seam canonico: as bordas (ingestao-coletar/ingestao-orquestrar)
// importam janelaMovel deste modulo (D6) e continuam resolvendo sem serem tocadas.
export { janelaMovel } from "./block-source.ts";

// ---------------------------------------------------------------------
// Checkpoint (execucoes.checkpoint jsonb) - secao 2.1.5
// ---------------------------------------------------------------------

export type CheckpointModo = "incremental" | "backfill";
export type CheckpointFase = "coleta" | "concluido";

export type NomusCheckpoint = {
  /** Proxima pagina a coletar (1-indexed). */
  pagina_atual: number;
  /** Limite inferior da janela (ISO-8601). */
  janela_inicio: string;
  /** Limite superior da janela (ISO-8601). */
  janela_fim: string;
  /** Modo do ciclo: incremental (janela movel) ou backfill (data_inicial). */
  modo: CheckpointModo;
  /** Ultima pagina integralmente processada. */
  concluido_paginas_ate: number;
  /** Fase corrente da execucao. */
  fase: CheckpointFase;
  /** Tentativas de retomada apos erro (teto NOMUS_MAX_RETOMADAS). */
  tentativas_retomada: number;
};

/** Monta o checkpoint inicial de uma nova execucao. */
export function buildInitialCheckpoint(
  modo: CheckpointModo,
  since: Date,
  until: Date,
): NomusCheckpoint {
  return {
    pagina_atual: 1,
    janela_inicio: since.toISOString(),
    janela_fim: until.toISOString(),
    modo,
    concluido_paginas_ate: 0,
    fase: "coleta",
    tentativas_retomada: 0,
  };
}

/**
 * Valida/normaliza um checkpoint vindo do banco (jsonb). Retorna null quando
 * invalido (sem pagina_atual/janela_inicio) — usado para decidir se uma
 * execucao em erro pode ser retomada.
 */
export function parseCheckpoint(raw: unknown): NomusCheckpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const pagina = typeof o.pagina_atual === "number" ? o.pagina_atual : NaN;
  const janelaInicio = typeof o.janela_inicio === "string" ? o.janela_inicio : "";
  if (!Number.isFinite(pagina) || pagina < 1 || janelaInicio === "") return null;
  const janelaFim = typeof o.janela_fim === "string" && o.janela_fim !== ""
    ? o.janela_fim
    : new Date().toISOString();
  return {
    pagina_atual: Math.floor(pagina),
    janela_inicio: janelaInicio,
    janela_fim: janelaFim,
    modo: o.modo === "backfill" ? "backfill" : "incremental",
    concluido_paginas_ate: typeof o.concluido_paginas_ate === "number"
      ? Math.max(0, Math.floor(o.concluido_paginas_ate))
      : 0,
    fase: o.fase === "concluido" ? "concluido" : "coleta",
    tentativas_retomada: typeof o.tentativas_retomada === "number"
      ? Math.max(0, Math.floor(o.tentativas_retomada))
      : 0,
  };
}

// ---------------------------------------------------------------------
// Tuning por env (mesmo PADRAO do conector: lido em runtime, saneado)
// ---------------------------------------------------------------------

export function nomusBlocoMaxPaginas(): number {
  return envInt("NOMUS_BLOCO_MAX_PAGINAS", 10);
}

export function nomusBlocoMaxMs(): number {
  return envInt("NOMUS_BLOCO_MAX_MS", 50_000);
}

export function nomusMaxRetomadas(): number {
  return envInt("NOMUS_MAX_RETOMADAS", 3);
}

// ---------------------------------------------------------------------
// Persistencia + indexacao de UM registro (isolamento de falha por item)
// ---------------------------------------------------------------------

export type PersistAcao = "inserido" | "atualizado" | "ignorado";

export interface PersistOutcome {
  acao: PersistAcao;
  reindexado: boolean;
  registroId: string | null;
}

export interface PersistContext {
  execucaoId: string;
  recurso: string;
  /** Allowlist de tipos a ingerir; lista vazia => nada e ingerido. */
  tiposAtivos: string[];
  /** Opcional: ausente => registro fica 'pendente' p/ indexacao futura. */
  embeddingProvider?: EmbeddingProvider;
}

/**
 * Persiste um CollectedRecord em nomus_processos com dedup por nomus_id e
 * decide a reindexacao por hash do conteudo canonico. Quando reindexa, regrava
 * memoria_chunks de forma idempotente. Lanca em falha (capturada pelo lote).
 */
export async function persistAndIndexRecord(
  db: SupabaseClient,
  ctx: PersistContext,
  record: CollectedRecord,
): Promise<PersistOutcome> {
  // 1. Allowlist por tipo: lista vazia => nada e ingerido; tipo fora da
  //    allowlist => ignorado (sem persistir).
  if (ctx.tiposAtivos.length === 0) {
    return { acao: "ignorado", reindexado: false, registroId: null };
  }
  if (!record.tipo || !ctx.tiposAtivos.includes(record.tipo)) {
    return { acao: "ignorado", reindexado: false, registroId: null };
  }

  // 2. Hash do conteudo canonico (descricao+nome+etapa) -> decide reindex.
  const novoHash = hashConteudoCanonico({
    descricao: record.descricao,
    nome: record.nome,
    etapa: record.etapa,
  });

  const { data: existing, error: selError } = await db
    .from("nomus_processos")
    .select("id, hash_conteudo")
    .eq("nomus_id", record.nomus_id)
    .maybeSingle();
  if (selError) {
    throw new Error(`falha ao consultar processo existente: ${selError.message}`);
  }

  const reindexar = !existing ||
    (existing as { hash_conteudo: string | null }).hash_conteudo !== novoHash;

  // 3. Upsert do snapshot vigente (payload_bruto verbatim, nunca mutado).
  const row: Record<string, unknown> = {
    nomus_id: record.nomus_id,
    tipo: record.tipo,
    etapa: record.etapa,
    empresa: record.empresa,
    pessoa: record.pessoa,
    nome: record.nome,
    reportador: record.reportador,
    responsavel: record.responsavel,
    descricao: record.descricao,
    data_criacao: record.data_criacao,
    data_alteracao: record.data_alteracao,
    payload_bruto: record.payload_bruto ?? {},
    hash_conteudo: novoHash,
  };
  // So marca 'pendente' quando vai reindexar; quando nao, omite a coluna para
  // nao sobrescrever o status_indexacao corrente (upsert grava o que for dado).
  if (reindexar) row.status_indexacao = "pendente";

  const { data: upserted, error: upError } = await db
    .from("nomus_processos")
    .upsert(row, { onConflict: "nomus_id", ignoreDuplicates: false })
    .select("id")
    .single();
  if (upError || !upserted) {
    throw new Error(`falha ao persistir processo: ${upError?.message ?? "sem id"}`);
  }
  const registroId = String((upserted as { id: string }).id);
  // acao reflete a decisao de reindex (hash do conteudo canonico): novo =>
  // 'inserido'; existente com hash MUDADO => 'atualizado'; existente com hash
  // IGUAL => 'ignorado' (o snapshot ainda e re-upsertado p/ manter campos fora
  // do hash atualizados, mas nada reindexa). Antes todo existente virava
  // 'atualizado' mesmo sem mudanca, inflando o contador de alterados no resync.
  const acao: PersistAcao = !existing ? "inserido" : (reindexar ? "atualizado" : "ignorado");

  // 4. Reindexacao (apenas quando o conteudo mudou e ha provider configurado).
  if (!reindexar) return { acao, reindexado: false, registroId };
  if (!ctx.embeddingProvider) {
    // Sem provider (v0): mantem 'pendente' para indexar numa fase posterior.
    return { acao, reindexado: false, registroId };
  }

  try {
    await setStatusIndexacao(db, registroId, "em_andamento");
    await generateAndStoreMemoriaChunks(
      db,
      {
        origem: "processo",
        tipo: processoOrigemFina(record),
        registroId,
        verbatim: buildProcessoVerbatim(record),
        provider: ctx.embeddingProvider,
      },
    );
    await setStatusIndexacao(db, registroId, "concluida");
  } catch (err) {
    await setStatusIndexacao(db, registroId, "erro");
    throw err;
  }

  return { acao, reindexado: true, registroId };
}

/**
 * Persiste uma CollectedPessoa em nomus_pessoas com dedup por nomus_id e decide
 * a reindexacao por hash do conteudo canonico da pessoa. Diferente dos
 * processos, NAO ha allowlist por `tipo` (pessoa nao tem tipo): o master switch
 * do recurso (`recursos.pessoas.ativo`) e checado na borda (Edge) antes do
 * loop. Quando reindexa, regrava memoria_chunks (origem='pessoa') de forma
 * idempotente. Lanca em falha (capturada pelo lote).
 */
export async function persistAndIndexPessoa(
  db: SupabaseClient,
  ctx: PersistContext,
  pessoa: CollectedPessoa,
): Promise<PersistOutcome> {
  // 1. Hash do conteudo canonico da pessoa -> decide reindex.
  const novoHash = hashPessoaConteudo(pessoa);

  const { data: existing, error: selError } = await db
    .from("nomus_pessoas")
    .select("id, hash_conteudo")
    .eq("nomus_id", pessoa.nomus_id)
    .maybeSingle();
  if (selError) {
    throw new Error(`falha ao consultar pessoa existente: ${selError.message}`);
  }

  const reindexar = !existing ||
    (existing as { hash_conteudo: string | null }).hash_conteudo !== novoHash;

  // 2. Upsert do snapshot vigente (payload_bruto verbatim, nunca mutado).
  const row: Record<string, unknown> = {
    nomus_id: pessoa.nomus_id,
    nome: pessoa.nome,
    nome_razao_social: pessoa.nome_razao_social,
    codigo: pessoa.codigo,
    cnpj: pessoa.cnpj,
    tipo_pessoa: pessoa.tipo_pessoa,
    ativo: pessoa.ativo,
    email: pessoa.email,
    telefone: pessoa.telefone,
    cep: pessoa.cep,
    endereco: pessoa.endereco,
    numero: pessoa.numero,
    complemento: pessoa.complemento,
    bairro_distrito: pessoa.bairro_distrito,
    municipio: pessoa.municipio,
    uf: pessoa.uf,
    pais: pessoa.pais,
    tipo_contribuinte_icms: pessoa.tipo_contribuinte_icms,
    observacoes: pessoa.observacoes,
    data_criacao: pessoa.data_criacao,
    data_modificacao: pessoa.data_modificacao,
    categorias: pessoa.categorias ?? null,
    analise_credito: pessoa.analise_credito ?? null,
    payload_bruto: pessoa.payload_bruto ?? {},
    hash_conteudo: novoHash,
  };
  if (reindexar) row.status_indexacao = "pendente";

  const { data: upserted, error: upError } = await db
    .from("nomus_pessoas")
    .upsert(row, { onConflict: "nomus_id", ignoreDuplicates: false })
    .select("id")
    .single();
  if (upError || !upserted) {
    throw new Error(`falha ao persistir pessoa: ${upError?.message ?? "sem id"}`);
  }
  const registroId = String((upserted as { id: string }).id);
  const acao: PersistAcao = !existing ? "inserido" : (reindexar ? "atualizado" : "ignorado");

  // 3. Reindexacao (apenas quando o conteudo mudou e ha provider configurado).
  if (!reindexar) return { acao, reindexado: false, registroId };
  if (!ctx.embeddingProvider) {
    return { acao, reindexado: false, registroId };
  }

  try {
    await setStatusIndexacaoPessoa(db, registroId, "em_andamento");
    await generateAndStoreMemoriaChunks(
      db,
      {
        origem: "pessoa",
        tipo: "pessoa",
        registroId,
        verbatim: buildPessoaVerbatim(pessoa),
        provider: ctx.embeddingProvider,
      },
    );
    await setStatusIndexacaoPessoa(db, registroId, "concluida");
  } catch (err) {
    await setStatusIndexacaoPessoa(db, registroId, "erro");
    throw err;
  }

  return { acao, reindexado: true, registroId };
}

// ---------------------------------------------------------------------
// Processamento de UM bloco de paginas (checkpoint/retomada)
// ---------------------------------------------------------------------

export interface BlockDeps {
  /** service_role: escrita server-side contornando RLS (SEC-05). */
  db: SupabaseClient;
  connector: NomusConnector;
  /** Opcional: ausente => itens ficam 'pendente' (sem embeddings). */
  embeddingProvider?: EmbeddingProvider;
  /** Fonte da execucao (para atualizar fontes.ultima_coleta_em ao concluir). */
  fonteId: string;
}

export interface BlockParams {
  execucaoId: string;
  recurso: string;
  tiposAtivos: string[];
  checkpoint: NomusCheckpoint;
  signal?: AbortSignal;
}

export interface BlockOutcome {
  estado: "em_andamento" | "concluida" | "erro";
  concluido: boolean;
  checkpoint: NomusCheckpoint;
  processadosSucesso: number;
  processadosErro: number;
}

/**
 * Processa UM bloco de paginas a partir de checkpoint.pagina_atual, encerrando
 * por teto de paginas (NOMUS_BLOCO_MAX_PAGINAS) ou tempo (NOMUS_BLOCO_MAX_MS).
 * Salva o checkpoint apos cada pagina (Realtime). Conclui a execucao quando a
 * varredura chega ao fim (pagina vazia); falha de infra -> 'erro' preservando
 * o checkpoint para retomada.
 */
export async function runNomusBlock(
  deps: BlockDeps,
  params: BlockParams,
): Promise<BlockOutcome> {
  const { db, connector, embeddingProvider, fonteId } = deps;
  const { execucaoId, recurso, tiposAtivos } = params;
  const checkpoint: NomusCheckpoint = { ...params.checkpoint };

  const maxPaginas = nomusBlocoMaxPaginas();
  const maxMs = nomusBlocoMaxMs();
  const startMs = Date.now();

  const counters = await loadCounters(db, execucaoId);

  const since = new Date(checkpoint.janela_inicio);
  const until = checkpoint.janela_fim ? new Date(checkpoint.janela_fim) : new Date();

  await updateExecucao(db, execucaoId, {
    status: "em_andamento",
    etapa_atual: "coleta",
    checkpoint,
  });

  const ctx: PersistContext = { execucaoId, recurso, tiposAtivos, embeddingProvider };
  let paginasNoBloco = 0;

  try {
    while (true) {
      if (params.signal?.aborted) break;
      if (paginasNoBloco >= maxPaginas) break;
      if (Date.now() - startMs >= maxMs) break;

      const page = await connector.collectPage(checkpoint.pagina_atual, {
        sinceDate: since,
        untilDate: until,
        signal: params.signal,
      });

      // Pagina vazia => fim da varredura: conclui a execucao.
      if (page.vazia) {
        checkpoint.fase = "concluido";
        await finalizeConcluida(db, execucaoId, fonteId, checkpoint, counters);
        return {
          estado: "concluida",
          concluido: true,
          checkpoint,
          processadosSucesso: counters.sucesso,
          processadosErro: counters.erro,
        };
      }

      for (const record of page.records) {
        if (params.signal?.aborted) break;
        try {
          const outcome = await persistAndIndexRecord(db, ctx, record);
          if (outcome.acao === "ignorado") continue;
          counters.sucesso += 1;
          if (outcome.acao === "inserido") counters.novos += 1;
          else counters.alterados += 1;
        } catch (err) {
          // Falha isolada do item: registra e segue (RNF-05). Mensagem SEM
          // payload (SEC-09): apenas nomus_id + motivo.
          counters.erro += 1;
          const etapa = err instanceof EmbeddingError ? "Indexacao" : "Persistencia";
          await recordIngestErro(db, {
            execucaoId,
            severidade: "media",
            etapa,
            origem: processoOrigemFina(record),
            recurso,
            registroId: await resolveProcessoId(db, record.nomus_id),
            mensagem: `falha ao processar processo ${record.nomus_id}: ${errorMessage(err)}`,
          });
        }
      }

      checkpoint.pagina_atual += 1;
      checkpoint.concluido_paginas_ate = checkpoint.pagina_atual - 1;
      paginasNoBloco += 1;

      await updateExecucao(db, execucaoId, {
        checkpoint,
        novos: counters.novos,
        alterados: counters.alterados,
        processados_sucesso: counters.sucesso,
        processados_erro: counters.erro,
      });
    }

    // Bloco encerrado por teto (ainda ha paginas): permanece em_andamento com
    // o checkpoint salvo, para o orquestrador retomar no proximo tique.
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
      origem: `processo-${recurso}`,
      recurso,
      mensagem: `falha de coleta no recurso ${recurso}: ${errorMessage(err)}`,
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
    await captureException(err, { scope: "nomus-pipeline", phase: "bloco", execucaoId });
    return {
      estado: "erro",
      concluido: false,
      checkpoint,
      processadosSucesso: counters.sucesso,
      processadosErro: counters.erro,
    };
  }
}

// ---------------------------------------------------------------------
// Helpers de conteudo / origem
// ---------------------------------------------------------------------

/**
 * Texto verbatim indexado de um processo: concatena os campos canonicos
 * disponiveis (nome, etapa, descricao). Vazio quando nenhum campo existe.
 */
export function buildProcessoVerbatim(record: CollectedRecord): string {
  return [record.nome, record.etapa, record.descricao]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join("\n\n");
}

/**
 * Discriminador fino de origem do processo (ex.: 'processo-venda-governamental').
 * Usado em memoria_chunks.tipo e erros_ingestao.origem (RF-34).
 */
export function processoOrigemFina(record: CollectedRecord): string {
  return `processo-${slugTipo(record.tipo)}`;
}

function slugTipo(tipo: string | null): string {
  const base = (tipo ?? "processo")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "processo";
}

const FIELD_SEP = "\u001f";

/** Chaves de `categorias` (15 booleans) cujo valor e true (ex.: ['cliente','lead']). */
function categoriasAtivas(categorias: Record<string, unknown> | null): string[] {
  if (!categorias) return [];
  return Object.entries(categorias)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}

/**
 * Texto verbatim indexado de uma pessoa: nome, razao social, observacoes (texto
 * livre do cliente), papeis ativos (categorias) e localizacao (municipio/uf).
 * Vazio quando nenhum campo util existe.
 */
export function buildPessoaVerbatim(pessoa: CollectedPessoa): string {
  const papeis = categoriasAtivas(pessoa.categorias);
  const local = [pessoa.municipio, pessoa.uf]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join(" / ");
  return [
    pessoa.nome,
    pessoa.nome_razao_social,
    pessoa.observacoes,
    papeis.length > 0 ? papeis.join(", ") : null,
    local || null,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join("\n\n");
}

/**
 * Hash do conteudo canonico da pessoa (decide reindexacao). Inclui os campos
 * textuais relevantes + categorias/analise_credito serializados, em ORDEM FIXA
 * com separador estavel. Alterar qualquer um altera o hash.
 */
function hashPessoaConteudo(pessoa: CollectedPessoa): string {
  const canonical = [
    pessoa.nome ?? "",
    pessoa.nome_razao_social ?? "",
    pessoa.observacoes ?? "",
    pessoa.email ?? "",
    pessoa.telefone ?? "",
    pessoa.municipio ?? "",
    pessoa.uf ?? "",
    pessoa.ativo === null ? "" : String(pessoa.ativo),
    pessoa.categorias ? JSON.stringify(pessoa.categorias) : "",
    pessoa.analise_credito ? JSON.stringify(pessoa.analise_credito) : "",
  ].join(FIELD_SEP);
  return hashTexto(canonical);
}

// ---------------------------------------------------------------------
// Helpers de estado / execucao
// ---------------------------------------------------------------------

async function setStatusIndexacao(
  db: SupabaseClient,
  registroId: string,
  status: "pendente" | "em_andamento" | "concluida" | "erro",
): Promise<void> {
  const { error } = await db
    .from("nomus_processos")
    .update({ status_indexacao: status })
    .eq("id", registroId);
  if (error) {
    console.error("[nomus-pipeline] falha ao atualizar status_indexacao", {
      registroId,
      status,
      error: error.message,
    });
  }
}

async function setStatusIndexacaoPessoa(
  db: SupabaseClient,
  registroId: string,
  status: "pendente" | "em_andamento" | "concluida" | "erro",
): Promise<void> {
  const { error } = await db
    .from("nomus_pessoas")
    .update({ status_indexacao: status })
    .eq("id", registroId);
  if (error) {
    console.error("[nomus-pipeline] falha ao atualizar status_indexacao (pessoa)", {
      registroId,
      status,
      error: error.message,
    });
  }
}

async function resolveProcessoId(db: SupabaseClient, nomusId: string): Promise<string | null> {
  const { data } = await db
    .from("nomus_processos")
    .select("id")
    .eq("nomus_id", nomusId)
    .maybeSingle();
  return data ? String((data as { id: string }).id) : null;
}
