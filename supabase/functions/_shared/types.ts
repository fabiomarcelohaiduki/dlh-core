// =====================================================================
// _shared/types.ts
// Tipos de dominio das respostas das Edge Functions (camelCase no contrato
// publico). Mapeados a partir das colunas snake_case do substrato (secao 2).
// =====================================================================

/** Status de ingestao exposto ao front (mapeado de operacional/degradado/parado). */
export type StatusIngestao = "Saudavel" | "Atencao" | "Falha";

export interface HealthcheckResponse {
  statusIngestao: StatusIngestao;
  ultimaSync: string | null;
  totalAvisos: number;
  totalProcessos: number;
  totalPessoas: number;
  itensComErro: number;
}

/**
 * Cursor/estado de retomada da execucao (execucoes.checkpoint jsonb, secao
 * 2.1.5). Multi-origem: presente para fontes em blocos (ex.: Nomus); null para
 * o pipeline Effecti monolitico (checkpoint vazio). Mapeado para camelCase.
 */
export interface ExecucaoCheckpoint {
  paginaAtual: number | null;
  fase: string | null;
  modo: string | null;
  tentativasRetomada: number | null;
}

export interface Execucao {
  id: string;
  inicio: string;
  fim: string | null;
  gatilho: string;
  janelaDias: number | null;
  novos: number;
  alterados: number;
  duracao: string | null;
  status: string;
  etapaAtual: string | null;
  totalProcessar: number | null;
  processadosSucesso: number | null;
  processadosErro: number | null;
  pendentes: number | null;
  /** Fonte da execucao (execucoes.fonte_id); null nas execucoes legadas. */
  fonteId: string | null;
  /** Origem/tipo da fonte ('effecti' | 'nomus'); null quando indeterminada. */
  origem: string | null;
  /** Recurso coletado (ex.: 'processos'); null para o Effecti monolitico. */
  recurso: string | null;
  /** Tipo-alvo do recurso (ex.: tipos ativos do Nomus). */
  tipoAlvo: string | null;
  /** Cursor de paginacao/retomada; null quando vazio (Effecti). */
  checkpoint: ExecucaoCheckpoint | null;
}

export interface Erro {
  id: string;
  execucaoId: string | null;
  avisoId: string | null;
  severidade: string;
  etapa: string;
  mensagem: string;
  quando: string;
  statusReprocesso: string | null;
  /** Origem do registro com falha ('aviso' = Effecti; 'processo-*' = Nomus). */
  origem: string;
  /** Recurso da fonte (ex.: 'processos'); null para o Effecti. */
  recurso: string | null;
  /** Referencia generica do registro de memoria (nomus_processos.id). */
  registroId: string | null;
}

export interface ChunkMetadata {
  id: string;
  ordem: number | null;
  temEmbedding: boolean;
  dimensoes: number | null;
}

export interface ArquivoMetadata {
  id: string;
  nomeArquivo: string | null;
  extensao: string | null;
  tamanhoBytes: number | null;
  storagePath: string | null;
  statusTratamento: string | null;
}

export interface AvisoIndice {
  statusIndexacao: string | null;
  chunks: ChunkMetadata[];
  arquivos: ArquivoMetadata[];
}

export interface AvisoDetalhe {
  id: string;
  conteudoVerbatim: string;
  payloadBruto: unknown;
  indice: AvisoIndice;
}

export interface AuthUser {
  email: string;
  perfil: "interno";
}

export interface AuthGoogleResponse {
  token: string;
  user: AuthUser;
}

export interface OAuthInitResponse {
  url: string;
}

/** PUT /fontes/effecti/credencial -> nunca retorna o segredo (RNF-02). */
export interface SalvarCredencialResponse {
  ok: boolean;
}

/** POST /fontes/effecti/testar -> estado da conexao + latencia medida. */
export interface TestarConexaoResponse {
  estadoConexao: "conectada" | "erro" | "nao_configurada";
  latenciaMs: number;
}

/** Estado da conexao de uma fonte (fontes.estado_conexao). */
export type EstadoConexao = "conectada" | "erro" | "nao_configurada";

/**
 * PUT /fontes-credencial (parametrizado por fonte) -> nunca retorna o segredo
 * (RNF-02/SEC-01). Confirma a fonte e o estado_conexao corrente.
 */
export interface SalvarCredencialResult {
  ok: boolean;
  fonte: string;
  estado_conexao: EstadoConexao;
}

/** Causa classificada do teste de conexao (null em sucesso). */
export type TestarConexaoCausa =
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  | "unknown"
  | "nao_configurada"
  | null;

/**
 * POST /fontes-testar (parametrizado por fonte) -> resultado do teste leve.
 * Expoe o contrato snake_case desta entrega (estado_conexao/causa/mensagem/
 * latencia_ms) e mantem os campos camelCase legados (estadoConexao/latenciaMs)
 * consumidos hoje pelo cockpit, durante a transicao.
 */
export interface TestarConexaoResult {
  estadoConexao: EstadoConexao;
  latenciaMs: number;
  estado_conexao: EstadoConexao;
  causa: TestarConexaoCausa;
  mensagem: string;
  latencia_ms: number;
}

/** GET /ingestao-config?fonte=... -> config corrente da fonte. */
export interface IngestaoConfigResult {
  fonte: string;
  janela_dias: number | null;
  data_inicial: string | null;
  recursos: Record<string, unknown>;
}

/** PUT /ingestao/config -> confirmacao de persistencia. */
export interface SalvarConfigResponse {
  ok: boolean;
}

/** POST /ingestao/coletar -> execucao criada e pipeline disparado. */
export interface ColetaResponse {
  execucaoId: string;
  status: "em_andamento";
}

/**
 * POST /ingestao-coletar (fonte multi-recurso, ex.: Nomus) -> contrato em
 * blocos. 202 ao criar/disparar; quando ja ha coleta ativa, 409 com
 * `ja_em_andamento=true` referenciando a execucao corrente.
 */
export interface ColetaNomusResponse {
  execucao_id: string;
  estado: "em_andamento";
  ja_em_andamento?: boolean;
}

/**
 * POST /ingestao-orquestrar -> resultado do tique do ciclo (single-flight).
 * `acao` resume o efeito: avancou (bloco), iniciou (nova execucao), concluiu
 * (varredura terminou) ou ocioso (nada a fazer). execucao_id/fonte/recurso
 * presentes quando houve trabalho.
 */
export interface OrquestrarResponse {
  acao: "avancou" | "iniciou" | "ocioso" | "concluiu";
  execucao_id: string | null;
  fonte: string | null;
  recurso: string | null;
}

/** POST /substrato/avisos/:id/reindexar -> status do reprocesso do item. */
export interface ReprocessarResponse {
  status: "reprocessado" | "em_andamento" | "ignorado";
}

/**
 * Um resultado da busca semantica /v1 no formato LEGADO (aviso resolvido).
 * Preservado de forma aditiva para nao quebrar o playground do cockpit, que
 * consome `results[].{ id, score, verbatim }`.
 */
export interface BuscaSemanticaResultItem {
  /** Id do registro mais similar (aviso_id, ou registro_id quando memoria). */
  id: string;
  /** Similaridade de cosseno (1 - distancia); maior = mais relevante. */
  score: number;
  /** Conteudo verbatim integro do registro (avisos/processos). */
  verbatim: string;
}

/**
 * Um resultado da busca semantica multi-origem /v1 (DD-03). Preserva os campos
 * hoje consumidos pela Lia (aviso_id, verbatim, similaridade) e ADICIONA os
 * campos agnosticos de origem (registro_id, origem). aviso_id e null para
 * registros de memoria (ex.: processos); registro_id e null para avisos puros.
 */
export interface BuscaSemanticaRegistro {
  /** Id do aviso (avisos.id) quando origem='aviso'; null para memoria. */
  aviso_id: string | null;
  /** Referencia generica do registro de memoria; null para avisos puros. */
  registro_id: string | null;
  /** Origem do chunk (ex.: 'aviso', 'processo'). */
  origem: string;
  /** Conteudo verbatim integro do registro. */
  verbatim: string;
  /** Similaridade de cosseno (1 - distancia); maior = mais relevante. */
  similaridade: number;
}

/**
 * POST /v1/substrato/busca-semantica -> top-K por similaridade de cosseno.
 * `resultados` e o contrato multi-origem (DD-03); `results` permanece como
 * espelho legado (compat aditiva com o playground do cockpit).
 */
export interface BuscaSemanticaResponse {
  resultados: BuscaSemanticaRegistro[];
  results: BuscaSemanticaResultItem[];
}

/**
 * POST /v1/lia/token -> resultado da gestao da API key de servico da Lia.
 * Em 'rotate', `apiKey` traz a chave recem-emitida UMA unica vez (para
 * configurar a Lia); em 'revoke', `apiKey` e null.
 */
export interface LiaTokenResponse {
  action: "rotate" | "revoke";
  ok: boolean;
  apiKey: string | null;
}
