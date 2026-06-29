// =====================================================================
// Camada de API da guia "Dados" (hub mestre-detalhe de registros coletados,
// agrupados por (fonte, registro_origem_id)). Consome as Edge Functions
// coleta-registros (lista + detalhe) via apiFetch (/proxy) + buildQuery, no
// padrao client.ts (ApiError). Responsabilidade unica: mapear o snake_case
// do contrato das Edges (SPEC 3.2.1/3.2.2) para o camelCase do client.
// =====================================================================

import { apiFetch, buildQuery } from "@/lib/api/client";

// ---------------------------------------------------------------------
// Enums de dominio (espelham _shared/registro-types.ts).
// ---------------------------------------------------------------------

/** Status de extracao de UM vinculo (documento_vinculos.status_extracao). */
export type StatusExtracao =
  | "pendente"
  | "extraido"
  | "herdado"
  | "erro"
  | "precisa_ocr"
  | "inobtenivel"
  | "ignorado";

/** Fonte coletavel (documento_vinculos.fonte). */
export type FonteColeta = "effecti" | "nomus" | "drive" | "gmail";

/**
 * Efeito de UMA execucao sobre UM registro: 'novo' (1a vez) ou 'atualizado'
 * (ja existia e foi tocado). Presente SO no recorte por execucao; null na
 * lista mestra cumulativa.
 */
export type EfeitoColeta = "novo" | "atualizado";

/** Estado AGREGADO de indexacao exibido na linha mestra (SPEC 4.5.4). */
export type StatusIndexacaoAgregado =
  | "pendente"
  | "em_andamento"
  | "concluida"
  | "erro"
  | "mista";

// ---------------------------------------------------------------------
// Cabecalho discriminado por fonte (camelCase; SPEC 3.2.1).
// ---------------------------------------------------------------------

/** Cabecalho de um aviso Effecti (colunas de `avisos` + payload_bruto). */
export interface CabecalhoEffecti {
  fonte: "effecti";
  objeto: string;
  orgao: string;
  modalidade: string;
  portal: string | null;
  dataPublicacao: string | null;
  dataCaptura: string;
  uf: string | null;
  uasg: string | null;
  edital: string | null;
}

/** Cabecalho de um processo Nomus (colunas diretas de `nomus_processos`). */
export interface CabecalhoNomus {
  fonte: "nomus";
  nomusId: string;
  etapa: string | null;
  pessoa: string | null;
  tipo: string | null;
  dataCriacao: string | null;
}

/** Cabecalho de um item Gmail (documento_vinculos + ref_obtencao). */
export interface CabecalhoGmail {
  fonte: "gmail";
  nomeAnexo: string;
  extensao: string | null;
  tipo: "corpo" | "anexo";
  threadId: string | null;
}

/** Cabecalho de um arquivo Drive (documento_vinculos + ref_obtencao). */
export interface CabecalhoDrive {
  fonte: "drive";
  nomeArquivo: string;
  mimeType: string | null;
}

/** Discriminated union pelo campo `fonte`. */
export type CabecalhoDiscriminado =
  | CabecalhoEffecti
  | CabecalhoNomus
  | CabecalhoGmail
  | CabecalhoDrive;

// ---------------------------------------------------------------------
// Linha mestra: RegistroColetado (SPEC 3.2.1).
// ---------------------------------------------------------------------

/** 1 linha por (fonte, registro_origem_id). Lista cumulativa. */
export interface RegistroColetado {
  /** `${fonte}:${registro_origem_id}` (chave estavel da linha mestra). */
  idComposto: string;
  fonte: FonteColeta;
  /** registro_origem_id da fonte (effecti_id / nomus_id / etc). */
  origemId: string;
  /** Momento da captacao (ISO-8601). */
  captadoEm: string;
  tituloCurto: string;
  qtdDocumentos: number;
  qtdPendentes: number;
  qtdErros: number;
  qtdIgnorado: number;
  /** true quando o registro possui link publico de origem (NOMUS sempre false). */
  temLinkPublico: boolean;
  statusIndexacaoAgregado: StatusIndexacaoAgregado;
  cabecalho: CabecalhoDiscriminado;
  /** Link publico da origem; null quando nao aplicavel (ex.: Nomus). */
  linkOriginal: string | null;
  /** Execucao de origem (so Effecti, via avisos.execucao_origem_id); null caso contrario. */
  execucaoOrigemId: string | null;
  /** avisos.id quando fonte='effecti'; null para as demais fontes. */
  avisoId: string | null;
  /**
   * Efeito desta execucao sobre o registro (novo|atualizado), presente SO
   * quando a lista vem recortada por execucao (clique numa execucao). null na
   * lista mestra cumulativa.
   */
  efeito: EfeitoColeta | null;
}

// ---------------------------------------------------------------------
// Detalhe expandido (SPEC 3.2.2).
// ---------------------------------------------------------------------

/** Um vinculo (anexo) do registro na expansao (alvo das acoes granulares). */
export interface VinculoDetalhe {
  /** documento_vinculos.id (uuid) — alvo de reprocessar/ignorar anexo. */
  id: string;
  documentoId: string | null;
  nomeAnexo: string;
  statusExtracao: StatusExtracao;
  erro: string | null;
  tentativasExtracao: number;
  linkOriginal: string | null;
  extensao: string | null;
  mimeType: string | null;
  tamanhoBytes: number | null;
  usouOcr: boolean | null;
  statusIndexacao: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Erro agregado do registro (subset de erros_ingestao). */
export interface RegistroErroIngestao {
  id: string;
  avisoId: string | null;
  execucaoId: string | null;
  severidade: string;
  etapa: string;
  mensagem: string;
  statusReprocesso: string | null;
  createdAt: string;
}

/** Subset de `execucoes` consumido por `execucaoOrigem` (so Effecti). */
export interface ExecucaoOrigem {
  id: string;
  status: string | null;
  fonte: string | null;
  iniciadaEm: string | null;
  finalizadaEm: string | null;
}

/** Detalhe de 1 registro (GET /coleta-registros/:id_composto). */
export interface RegistroColetadoDetalhe {
  cabecalho: CabecalhoDiscriminado;
  vinculos: VinculoDetalhe[];
  erros: RegistroErroIngestao[];
  execucaoOrigem: ExecucaoOrigem | null;
  linkOriginal: string | null;
}

// ---------------------------------------------------------------------
// Response da lista (SPEC 3.2.1).
// ---------------------------------------------------------------------

/** Contagens cumulativas por fonte + total. */
export interface ContagensPorFonte {
  effecti: number;
  nomus: number;
  gmail: number;
  drive: number;
  total: number;
}

/** GET /coleta-registros -> lista paginada por keyset + contagens. */
export interface ColetaRegistrosResponse {
  itens: RegistroColetado[];
  nextCursor: string | null;
  contagensPorFonte: ContagensPorFonte;
}

/** Filtros da lista mestra (keyset). Convertidos para snake_case na query. */
export interface ColetaRegistrosParams {
  /** Teto por pagina (default 25 no Edge, teto 100). */
  limit?: number;
  /** Cursor de keyset (opaco) da pagina anterior. */
  cursor?: string | null;
  /** Filtra por fonte coletavel. */
  fonte?: FonteColeta | null;
  /** Filtra por status_indexacao_agregado. */
  status?: StatusIndexacaoAgregado | null;
  /** Busca textual (min. 2 chars trimados, validado no Edge). */
  busca?: string | null;
  /** Apenas registros com algum vinculo em erro. */
  temErro?: boolean | null;
  /**
   * Recorte por execucao (clique numa execucao da guia Execucoes): id da
   * execucao. Quando presente, a lista vem do ledger (so os registros tocados
   * por aquela rodada, rotulados novo|atualizado); null na lista mestra.
   */
  execucaoId?: string | null;
}

// ---------------------------------------------------------------------
// Shapes de transporte (snake_case) recebidos das Edge Functions.
// ---------------------------------------------------------------------

interface RawCabecalhoEffecti {
  fonte: "effecti";
  objeto: string;
  orgao: string;
  modalidade: string;
  portal: string | null;
  data_publicacao: string | null;
  data_captura: string;
  uf: string | null;
  uasg: string | null;
  edital: string | null;
}

interface RawCabecalhoNomus {
  fonte: "nomus";
  nomus_id: string;
  etapa: string | null;
  pessoa: string | null;
  tipo: string | null;
  data_criacao: string | null;
}

interface RawCabecalhoGmail {
  fonte: "gmail";
  nome_anexo: string;
  extensao: string | null;
  tipo: "corpo" | "anexo";
  thread_id: string | null;
}

interface RawCabecalhoDrive {
  fonte: "drive";
  nome_arquivo: string;
  mime_type: string | null;
}

type RawCabecalho =
  | RawCabecalhoEffecti
  | RawCabecalhoNomus
  | RawCabecalhoGmail
  | RawCabecalhoDrive;

interface RawRegistroColetado {
  id_composto: string;
  fonte: FonteColeta;
  origem_id: string;
  captado_em: string;
  titulo_curto: string;
  qtd_documentos: number;
  qtd_pendentes: number;
  qtd_erros: number;
  qtd_ignorado: number;
  tem_link_publico: boolean;
  status_indexacao_agregado: StatusIndexacaoAgregado;
  cabecalho: RawCabecalho;
  link_original: string | null;
  execucao_origem_id: string | null;
  aviso_id: string | null;
  efeito?: EfeitoColeta | null;
}

interface RawVinculoDetalhe {
  id: string;
  documento_id: string | null;
  nome_anexo: string;
  status_extracao: StatusExtracao;
  erro: string | null;
  tentativas_extracao: number;
  link_original: string | null;
  extensao: string | null;
  mime_type: string | null;
  tamanho_bytes: number | null;
  usou_ocr: boolean | null;
  status_indexacao: string | null;
  created_at: string;
  updated_at: string;
}

interface RawErroIngestao {
  id: string;
  aviso_id: string | null;
  execucao_id: string | null;
  severidade: string;
  etapa: string;
  mensagem: string;
  status_reprocesso: string | null;
  created_at: string;
}

interface RawExecucaoOrigem {
  id: string;
  status: string | null;
  fonte: string | null;
  iniciada_em: string | null;
  finalizada_em: string | null;
}

interface RawColetaRegistrosResponse {
  itens?: RawRegistroColetado[];
  nextCursor?: string | null;
  contagensPorFonte?: Partial<ContagensPorFonte>;
}

interface RawRegistroColetadoDetalhe {
  cabecalho: RawCabecalho;
  vinculos?: RawVinculoDetalhe[];
  erros?: RawErroIngestao[];
  execucao_origem?: RawExecucaoOrigem | null;
  link_original: string | null;
}

// ---------------------------------------------------------------------
// Mapeadores snake_case -> camelCase.
// ---------------------------------------------------------------------

function toCabecalho(raw: RawCabecalho): CabecalhoDiscriminado {
  switch (raw.fonte) {
    case "effecti":
      return {
        fonte: "effecti",
        objeto: raw.objeto,
        orgao: raw.orgao,
        modalidade: raw.modalidade,
        portal: raw.portal ?? null,
        dataPublicacao: raw.data_publicacao ?? null,
        dataCaptura: raw.data_captura,
        uf: raw.uf ?? null,
        uasg: raw.uasg ?? null,
        edital: raw.edital ?? null,
      };
    case "nomus":
      return {
        fonte: "nomus",
        nomusId: raw.nomus_id,
        etapa: raw.etapa ?? null,
        pessoa: raw.pessoa ?? null,
        tipo: raw.tipo ?? null,
        dataCriacao: raw.data_criacao ?? null,
      };
    case "gmail":
      return {
        fonte: "gmail",
        nomeAnexo: raw.nome_anexo,
        extensao: raw.extensao ?? null,
        tipo: raw.tipo,
        threadId: raw.thread_id ?? null,
      };
    case "drive":
      return {
        fonte: "drive",
        nomeArquivo: raw.nome_arquivo,
        mimeType: raw.mime_type ?? null,
      };
  }
}

function toRegistroColetado(raw: RawRegistroColetado): RegistroColetado {
  return {
    idComposto: raw.id_composto,
    fonte: raw.fonte,
    origemId: raw.origem_id,
    captadoEm: raw.captado_em,
    tituloCurto: raw.titulo_curto,
    qtdDocumentos: raw.qtd_documentos ?? 0,
    qtdPendentes: raw.qtd_pendentes ?? 0,
    qtdErros: raw.qtd_erros ?? 0,
    qtdIgnorado: raw.qtd_ignorado ?? 0,
    temLinkPublico: raw.tem_link_publico === true,
    statusIndexacaoAgregado: raw.status_indexacao_agregado,
    cabecalho: toCabecalho(raw.cabecalho),
    linkOriginal: raw.link_original ?? null,
    execucaoOrigemId: raw.execucao_origem_id ?? null,
    avisoId: raw.aviso_id ?? null,
    efeito: raw.efeito ?? null,
  };
}

function toVinculoDetalhe(raw: RawVinculoDetalhe): VinculoDetalhe {
  return {
    id: raw.id,
    documentoId: raw.documento_id ?? null,
    nomeAnexo: raw.nome_anexo,
    statusExtracao: raw.status_extracao,
    erro: raw.erro ?? null,
    tentativasExtracao: raw.tentativas_extracao ?? 0,
    linkOriginal: raw.link_original ?? null,
    extensao: raw.extensao ?? null,
    mimeType: raw.mime_type ?? null,
    tamanhoBytes: raw.tamanho_bytes ?? null,
    usouOcr: raw.usou_ocr ?? null,
    statusIndexacao: raw.status_indexacao ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toErroIngestao(raw: RawErroIngestao): RegistroErroIngestao {
  return {
    id: raw.id,
    avisoId: raw.aviso_id ?? null,
    execucaoId: raw.execucao_id ?? null,
    severidade: raw.severidade,
    etapa: raw.etapa,
    mensagem: raw.mensagem,
    statusReprocesso: raw.status_reprocesso ?? null,
    createdAt: raw.created_at,
  };
}

function toExecucaoOrigem(raw: RawExecucaoOrigem | null | undefined): ExecucaoOrigem | null {
  if (!raw) return null;
  return {
    id: raw.id,
    status: raw.status ?? null,
    fonte: raw.fonte ?? null,
    iniciadaEm: raw.iniciada_em ?? null,
    finalizadaEm: raw.finalizada_em ?? null,
  };
}

function toColetaRegistrosResponse(raw: RawColetaRegistrosResponse): ColetaRegistrosResponse {
  return {
    itens: (raw.itens ?? []).map(toRegistroColetado),
    nextCursor: raw.nextCursor ?? null,
    contagensPorFonte: {
      effecti: raw.contagensPorFonte?.effecti ?? 0,
      nomus: raw.contagensPorFonte?.nomus ?? 0,
      gmail: raw.contagensPorFonte?.gmail ?? 0,
      drive: raw.contagensPorFonte?.drive ?? 0,
      total: raw.contagensPorFonte?.total ?? 0,
    },
  };
}

function toRegistroColetadoDetalhe(raw: RawRegistroColetadoDetalhe): RegistroColetadoDetalhe {
  return {
    cabecalho: toCabecalho(raw.cabecalho),
    vinculos: (raw.vinculos ?? []).map(toVinculoDetalhe),
    erros: (raw.erros ?? []).map(toErroIngestao),
    execucaoOrigem: toExecucaoOrigem(raw.execucao_origem),
    linkOriginal: raw.link_original ?? null,
  };
}

// ---------------------------------------------------------------------
// Fetchers.
// ---------------------------------------------------------------------

/**
 * GET /coleta-registros — lista mestra cumulativa por keyset (1 linha por
 * (fonte, registro_origem_id)). Os filtros camelCase sao convertidos para a
 * query snake_case do Edge (temErro -> tem_erro). Sem Realtime (US-LISTA-03).
 */
export function fetchColetaRegistros(
  params: ColetaRegistrosParams = {},
  signal?: AbortSignal,
): Promise<ColetaRegistrosResponse> {
  const qs = buildQuery({
    limit: params.limit,
    cursor: params.cursor,
    fonte: params.fonte,
    status: params.status,
    busca: params.busca,
    tem_erro: params.temErro,
    execucao_id: params.execucaoId,
  });
  return apiFetch<RawColetaRegistrosResponse>(`coleta-registros${qs}`, {
    method: "GET",
    signal,
  }).then(toColetaRegistrosResponse);
}

/**
 * GET /coleta-registros/:id_composto — detalhe expandido de 1 registro. O
 * id_composto (`${fonte}:${origem_id}`) e URL-encodado no path (o ':' e o que
 * o Edge URL-decoda e parseia em (fonte, registro_origem_id)).
 */
export function fetchColetaRegistroDetalhe(
  idComposto: string,
  signal?: AbortSignal,
): Promise<RegistroColetadoDetalhe> {
  return apiFetch<RawRegistroColetadoDetalhe>(
    `coleta-registros/${encodeURIComponent(idComposto)}`,
    { method: "GET", signal },
  ).then(toRegistroColetadoDetalhe);
}
