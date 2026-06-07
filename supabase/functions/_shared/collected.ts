// =====================================================================
// _shared/collected.ts
// Tipos de registros coletados por conectores de fonte.
//
// `CollectedRecord` e o contrato de dados GENERICO produzido por fontes
// multi-recurso (ex.: Nomus/ERP), distinto de `CollectedAviso` (contrato
// proprio do Effecti). Os dois tipos COEXISTEM: o Effecti permanece
// inalterado e e apenas re-exportado aqui por conveniencia de import
// (RNF-17 - reaproveita o PADRAO, nao o tipo do Effecti).
//
// Convencao: os campos de `CollectedRecord` usam snake_case espelhando as
// colunas de `nomus_processos` (RF-12), facilitando o upsert no substrato.
// `payload_bruto` e o payload integral do GET, preservado VERBATIM e nunca
// mutado (US-06, RF-17).
// =====================================================================

// Re-exporta o tipo do Effecti SEM alterar sua definicao (continua sendo a
// fonte de verdade em effecti-connector.ts). Mantem CollectedAviso disponivel
// tambem a partir deste modulo para quem prefira um ponto unico de import.
export type { CollectedAviso } from "./effecti-connector.ts";

/**
 * Registro generico coletado de uma fonte multi-recurso (Nomus - RF-12).
 *
 * Mapeamento de origem (GET /rest/processos -> CollectedRecord):
 *   id -> nomus_id; demais campos preservam o nome canonico do processo.
 * `payload_bruto` guarda o objeto bruto integral (verbatim).
 */
export interface CollectedRecord {
  /** Chave natural de dedup (vem de `id` na API Nomus). Sempre presente. */
  nomus_id: string;
  /** Tipo do processo (ex.: "Venda Governamental"). */
  tipo: string | null;
  /** Etapa/estado vigente do processo (snapshot, sem historico). */
  etapa: string | null;
  /** Empresa de origem (famaha/darlu). NAO compoe a dedup (US-08). */
  empresa: string | null;
  /** Pessoa/cliente associada ao processo. */
  pessoa: string | null;
  /** Nome/titulo do processo. */
  nome: string | null;
  /** Reportador do processo. */
  reportador: string | null;
  /** Responsavel pelo processo. */
  responsavel: string | null;
  /** Descricao - principal conteudo textual indexado. */
  descricao: string | null;
  /** Data de criacao na API (ISO-8601) quando disponivel. */
  data_criacao: string | null;
  /** Data da ultima alteracao na API (ISO-8601) quando exposta (DD-02). */
  data_alteracao: string | null;
  /** Payload bruto integral do GET, preservado verbatim (nunca mutado). */
  payload_bruto: unknown;
}
