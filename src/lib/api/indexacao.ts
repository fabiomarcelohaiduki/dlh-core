import { apiFetch } from "@/lib/api/client";
import type { ConfigIndexacaoState, FonteIndexacao } from "@/lib/api/types";

// ---------------------------------------------------------------------
// Cliente do Edge `indexacao` (painel da INDEXACAO / embeddings).
//   - salvarConfigIndexacao: PUT do singleton config_indexacao (master
//     switch, fontes, orcamento, pausa). A LEITURA e hidratada server-side
//     (RLS) na pagina Coleta; aqui fica so a ESCRITA.
//   - fetchIndexacaoRegistros: POST { action:"registros" } -> uma pagina
//     (keyset) da lista mestra + contagens (chips/cards) da guia Indexacao.
//   - dispararIndexacao: POST { action:"disparar" } -> aciona 1 lote de
//     backfill (auto-encadeado). So gasta quando o master switch esta ON.
// Contrato em camelCase; o Edge mapeia para snake e valida.
// ---------------------------------------------------------------------

/**
 * Payload (camel) do PUT /indexacao — MERGE PARCIAL. A config tem dois donos
 * disjuntos no cockpit (o toggle do Agendamento manda ativo+processosAtivo; o
 * drawer de Parametros manda o resto). Cada chamador envia SO as suas chaves; a
 * Edge sobrepoe na linha existente sem zerar o que o outro form possui.
 */
export type SalvarConfigIndexacaoInput = Partial<ConfigIndexacaoState>;

/**
 * PUT /indexacao — persiste (por merge) a config da indexacao (embeddings).
 * Vale na PROXIMA invocacao do backfill e no proximo push do continuo; nao
 * afeta um lote em andamento. Manda apenas as chaves presentes em `input`.
 */
export function salvarConfigIndexacao(
  input: SalvarConfigIndexacaoInput,
): Promise<{ ok: boolean }> {
  const body: Record<string, unknown> = {};
  if (input.ativo !== undefined) body.ativo = input.ativo;
  if (input.processosAtivo !== undefined) body.processosAtivo = input.processosAtivo;
  if (input.fontesHabilitadas !== undefined) body.fontesHabilitadas = input.fontesHabilitadas;
  if (input.loteChunks !== undefined) body.loteChunks = input.loteChunks;
  if (input.pausaMs !== undefined) body.pausaMs = input.pausaMs;
  if (input.tpmAlvo !== undefined) body.tpmAlvo = input.tpmAlvo;
  if (input.tentativasMax !== undefined) body.tentativasMax = input.tentativasMax;
  if (input.embeddingsProvider !== undefined) body.embeddingsProvider = input.embeddingsProvider;
  if (input.embeddingsEndpoint !== undefined) body.embeddingsEndpoint = input.embeddingsEndpoint;
  return apiFetch<{ ok: boolean }>("indexacao", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/**
 * POST /indexacao { action:"disparar" } — aciona 1 lote de backfill da
 * indexacao AGORA (auto-encadeado ate esgotar a fila). So tem efeito quando o
 * master switch (ativo) esta ON; OFF => no-op no documentos-indexar.
 */
export function dispararIndexacao(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("indexacao", {
    method: "POST",
    body: JSON.stringify({ action: "disparar" }),
  });
}

/**
 * POST /indexacao { action:"reprocessar_erros", fontes? } — move os documentos
 * em status_indexacao=erro de volta para pendente (filtrado pela[s] fonte[s]
 * indexada[s]) e reabre o backfill. Retry idempotente (erros de backfill sao
 * transitorios; chunks inseridos atomicamente no fim do doc). So gasta quando o
 * master switch (ativo) esta ON. Devolve a quantidade reenfileirada.
 */
export function reprocessarErrosIndexacao(
  fontes?: FonteIndexacao[] | null,
): Promise<{ ok: boolean; reenfileirados: number }> {
  const body: Record<string, unknown> = { action: "reprocessar_erros" };
  if (fontes && fontes.length > 0) body.fontes = fontes;
  return apiFetch<{ ok: boolean; reenfileirados?: number }>("indexacao", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((raw) => ({ ok: raw.ok, reenfileirados: raw.reenfileirados ?? 0 }));
}

// =====================================================================
// Lista mestra da guia Indexacao (POST { action:"registros" }). Espelha o
// contrato fila-paginada da Extracao: keyset, chips por fonte, cards por
// status consolidado. Tipos co-locados aqui (como documentos.ts faz) para
// nao inchar o types.ts gigante.
// =====================================================================

/** Status consolidado (corpo + anexos) de um registro na guia Indexacao. */
export type IndexacaoStatusConsolidado =
  | "aguardando_extracao"
  | "erro"
  | "indexando"
  | "pendente"
  | "indexado"
  | "sem_conteudo";

/** Uma linha da lista mestra de indexacao (1 por fonte+recurso+registro). */
export interface IndexacaoRegistroItem {
  idComposto: string;
  fonte: FonteIndexacao;
  recurso: string;
  registroOrigemId: string;
  captadoEm: string | null;
  status: IndexacaoStatusConsolidado;
  /** Status do CORPO (effecti/nomus); null para gmail/drive (so anexos). */
  corpoStatus: string | null;
  anexosIndexavel: number;
  anexosIndexados: number;
  anexosPendente: number;
  anexosAndamento: number;
  anexosErro: number;
  /** Anexos ainda nao extraidos (aguardam a etapa anterior). */
  anexosAguardando: number;
  /** Titulo do registro: objeto do aviso, nomus_id, nome da pessoa; ou nome do anexo (gmail/drive). */
  tituloCurto: string;
}

/** Cursor keyset opaco (captado_em, id_composto). */
export interface IndexacaoRegistroCursor {
  c: string;
  k: string;
}

/** Contagens para chips (fonte), pilulas (recurso) e cards (status). */
export interface IndexacaoContagens {
  porFonte: Record<FonteIndexacao, number>;
  porRecurso: Record<string, Record<string, number>>;
  porStatus: Record<IndexacaoStatusConsolidado, number>;
  total: number;
}

export interface IndexacaoRegistrosResponse {
  itens: IndexacaoRegistroItem[];
  nextCursor: IndexacaoRegistroCursor | null;
  contagens: IndexacaoContagens;
}

export interface FetchIndexacaoRegistrosParams {
  fonte?: FonteIndexacao | null;
  recurso?: string | null;
  status?: IndexacaoStatusConsolidado | null;
  busca?: string | null;
  cursor?: IndexacaoRegistroCursor | null;
  limit?: number;
}

interface IndexacaoRegistrosRaw {
  itens?: IndexacaoRegistroItem[];
  nextCursor?: IndexacaoRegistroCursor | null;
  contagens?: Partial<IndexacaoContagens>;
}

/**
 * POST /indexacao { action:"registros" } — uma pagina (keyset) da lista mestra
 * de indexacao mais as contagens (chips/pilulas/cards). Read-only.
 */
export function fetchIndexacaoRegistros(
  params: FetchIndexacaoRegistrosParams = {},
): Promise<IndexacaoRegistrosResponse> {
  const body: Record<string, unknown> = { action: "registros" };
  if (params.fonte) body.fonte = params.fonte;
  if (params.recurso) body.recurso = params.recurso;
  if (params.status) body.status = params.status;
  if (params.busca && params.busca.trim().length > 0) body.busca = params.busca.trim();
  if (params.cursor) body.cursor = params.cursor;
  if (params.limit) body.limit = params.limit;

  return apiFetch<IndexacaoRegistrosRaw>("indexacao", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((raw) => ({
    itens: raw.itens ?? [],
    nextCursor: raw.nextCursor ?? null,
    contagens: {
      porFonte: {
        effecti: raw.contagens?.porFonte?.effecti ?? 0,
        nomus: raw.contagens?.porFonte?.nomus ?? 0,
        gmail: raw.contagens?.porFonte?.gmail ?? 0,
        drive: raw.contagens?.porFonte?.drive ?? 0,
      },
      porRecurso: raw.contagens?.porRecurso ?? {},
      porStatus: {
        aguardando_extracao: raw.contagens?.porStatus?.aguardando_extracao ?? 0,
        erro: raw.contagens?.porStatus?.erro ?? 0,
        indexando: raw.contagens?.porStatus?.indexando ?? 0,
        pendente: raw.contagens?.porStatus?.pendente ?? 0,
        indexado: raw.contagens?.porStatus?.indexado ?? 0,
        sem_conteudo: raw.contagens?.porStatus?.sem_conteudo ?? 0,
      },
      total: raw.contagens?.total ?? 0,
    },
  }));
}
