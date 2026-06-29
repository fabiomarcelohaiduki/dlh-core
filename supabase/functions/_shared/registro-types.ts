// =====================================================================
// _shared/registro-types.ts
// Tipos da guia "Dados" (hub mestre-detalhe de registros coletados,
// agrupados por (fonte, registro_origem_id)). Contrato snake_case no
// response (espelha SPEC secoes 3.2.1 e 3.2.2). Modulo PROPRIO da feature:
// coabita com _shared/types.ts SEM substitui-lo nem altera-lo.
// Artefato puro: sem dependencia de rede, banco ou cliente HTTP.
// =====================================================================

// ---------------------------------------------------------------------
// Enums de dominio
// ---------------------------------------------------------------------

/**
 * Status de extracao de UM vinculo (documento_vinculos.status_extracao).
 * Os 7 valores travados pelo CHECK do schema (SPEC 2.1.1).
 */
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
 * Fonte canonica do ledger `execucao_registros` (coluna `fonte` da PK). Mesmo
 * universo de FonteColeta; nome distinto para amarrar a assinatura do write-back
 * a chave do ledger.
 */
export type FonteCanonical = "effecti" | "nomus" | "gmail" | "drive";

/**
 * Recurso canonico do ledger `execucao_registros` (coluna `recurso` da nova PK
 * composta). NOT NULL: a PK nao aceita nulo, entao o write-back exige recurso.
 */
export type RecursoCanonical =
  | "avisos"
  | "processos"
  | "pessoas"
  | "mensagens"
  | "arquivos";

/**
 * Efeito de UMA execucao sobre UM registro (ledger execucao_registros): 'novo'
 * (1a vez que entrou) ou 'atualizado' (ja existia e foi mexido). Preenchido so
 * quando a lista vem recortada por execucao (clique numa execucao); null na
 * lista mestra cumulativa.
 */
export type EfeitoColeta = "novo" | "atualizado";

/**
 * Estado AGREGADO de indexacao exibido na linha mestra. Derivado de forma
 * deterministica a partir dos status_extracao dos vinculos (SPEC 4.5.4).
 */
export type StatusIndexacaoAgregado =
  | "sem_documentos"
  | "pendente"
  | "em_andamento"
  | "concluida"
  | "erro"
  | "mista";

// ---------------------------------------------------------------------
// Cabecalho discriminado por fonte (SPEC 3.2.1)
// ---------------------------------------------------------------------

/** Cabecalho de um aviso Effecti (colunas de `avisos` + extracao de payload_bruto). */
export interface CabecalhoEffecti {
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

/** Cabecalho de um processo Nomus (colunas diretas de `nomus_processos`). */
export interface CabecalhoNomus {
  fonte: "nomus";
  nomus_id: string;
  etapa: string | null;
  pessoa: string | null;
  tipo: string | null;
  data_criacao: string | null;
}

/**
 * Cabecalho de uma pessoa Nomus (recurso `pessoas`, colunas de `nomus_pessoas`).
 * Discriminado por (fonte, recurso) — coabita com CabecalhoNomus (processos) sob
 * fonte='nomus'. Campos podem ser null exceto os discriminantes e `nomusId`.
 */
export interface CabecalhoNomusPessoa {
  fonte: "nomus";
  recurso: "pessoas";
  nome: string | null;
  cnpj: string | null;
  tipoPessoa: string | null;
  municipio: string | null;
  uf: string | null;
  categorias?: string[] | null;
  codigo: string | null;
  nomusId: string;
}

/** Cabecalho de um item Gmail (documento_vinculos + ref_obtencao). */
export interface CabecalhoGmail {
  fonte: "gmail";
  nome_anexo: string;
  extensao: string | null;
  tipo: "corpo" | "anexo";
  thread_id: string | null;
  /** Assunto do e-mail (header Subject). */
  assunto: string | null;
  /** Remetente do e-mail (header From). */
  remetente: string | null;
  /** Destinatarios do e-mail (header To); pode listar varios enderecos. */
  destinatarios: string | null;
  /** Copia do e-mail (header Cc); pode listar varios enderecos. */
  cc: string | null;
  /** Data de envio do e-mail (header Date), ISO-8601; null se ausente. */
  data_email: string | null;
}

/** Cabecalho de um arquivo Drive (documento_vinculos + ref_obtencao). */
export interface CabecalhoDrive {
  fonte: "drive";
  nome_arquivo: string;
  mime_type: string | null;
}

/**
 * Discriminated union pelo campo `fonte`. O renderer escolhe a variante pelo
 * discriminante; campos derivados de JSONB sao sempre null-safe (ausencia ->
 * null, nunca quebra o render).
 */
export type CabecalhoDiscriminado =
  | CabecalhoEffecti
  | CabecalhoNomus
  | CabecalhoNomusPessoa
  | CabecalhoGmail
  | CabecalhoDrive;

// ---------------------------------------------------------------------
// Linha mestra: RegistroColetado (SPEC 3.2.1)
// ---------------------------------------------------------------------

/**
 * 1 linha por (fonte, registro_origem_id). Lista cumulativa, sem filtro de
 * triagem. Contagens agregam os vinculos do registro.
 */
export interface RegistroColetado {
  /** `${fonte}:${registro_origem_id}` (chave estavel da linha mestra). */
  id_composto: string;
  fonte: FonteColeta;
  /** registro_origem_id da fonte (effecti_id / nomus_id / etc). */
  origem_id: string;
  /** Momento da captacao (ISO-8601). */
  captado_em: string;
  titulo_curto: string;
  qtd_documentos: number;
  qtd_pendentes: number;
  qtd_erros: number;
  qtd_ignorado: number;
  /** true quando o registro possui link publico de origem (NOMUS sempre false). */
  tem_link_publico: boolean;
  status_indexacao_agregado: StatusIndexacaoAgregado;
  cabecalho: CabecalhoDiscriminado;
  /** Link publico da origem; null quando nao aplicavel (ex.: Nomus). */
  link_original: string | null;
  /** Execucao de origem (so Effecti, via avisos.execucao_origem_id); null caso contrario. */
  execucao_origem_id: string | null;
  /** avisos.id quando fonte='effecti'; null para as demais fontes. */
  aviso_id: string | null;
  /**
   * Efeito desta execucao sobre o registro (novo|atualizado), presente SO
   * quando a lista vem recortada por execucao (clique numa execucao). null na
   * lista mestra cumulativa.
   */
  efeito: EfeitoColeta | null;
}

// ---------------------------------------------------------------------
// Detalhe expandido (SPEC 3.2.2)
// ---------------------------------------------------------------------

/**
 * Um vinculo (anexo) do registro na expansao. Mapeia documento_vinculos
 * (+ documentos quando documento_id resolvido). `id` e o alvo das acoes de
 * reprocessar/ignorar anexo.
 */
export interface VinculoDetalhe {
  /** documento_vinculos.id (uuid) — alvo das acoes granulares. */
  id: string;
  /** FK documentos.id; null ate o documento ser resolvido. */
  documento_id: string | null;
  nome_anexo: string;
  status_extracao: StatusExtracao;
  erro: string | null;
  tentativas_extracao: number;
  /** Link do anexo na origem; null quando indisponivel. */
  link_original: string | null;
  /** documentos.extensao quando resolvido. */
  extensao: string | null;
  /** mime_type derivado (ex.: ref_obtencao do Drive) quando houver. */
  mime_type: string | null;
  /** documentos.tamanho_bytes quando resolvido. */
  tamanho_bytes: number | null;
  /** documentos.usou_ocr quando resolvido. */
  usou_ocr: boolean | null;
  /** documentos.status_indexacao quando resolvido. */
  status_indexacao: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Erro agregado do registro (erros_ingestao). Subset consumido pela secao de
 * erros da expansao; snake_case no response.
 */
export interface ErroIngestao {
  id: string;
  aviso_id: string | null;
  execucao_id: string | null;
  severidade: string;
  etapa: string;
  mensagem: string;
  status_reprocesso: string | null;
  created_at: string;
}

/**
 * Subset de `execucoes` consumido por `execucao_origem` na expansao (so
 * Effecti, via avisos.execucao_origem_id). snake_case no response (espelha
 * SPEC 3.2.2). NAO confundir com a interface Execucao (camelCase) de
 * _shared/types.ts, que pertence ao contrato de monitoramento.
 */
export interface Execucao {
  id: string;
  status: string | null;
  fonte: string | null;
  iniciada_em: string | null;
  finalizada_em: string | null;
}

/** Detalhe de 1 registro (GET /coleta-registros/:id_composto). */
export interface RegistroColetadoDetalhe {
  cabecalho: CabecalhoDiscriminado;
  vinculos: VinculoDetalhe[];
  erros: ErroIngestao[];
  execucao_origem: Execucao | null;
  link_original: string | null;
}

// ---------------------------------------------------------------------
// Response da lista (SPEC 3.2.1)
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
