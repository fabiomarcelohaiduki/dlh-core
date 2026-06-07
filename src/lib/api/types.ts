// =====================================================================
// Tipos do contrato publico das Edge Functions de monitoramento (camelCase).
// Espelham supabase/functions/_shared/types.ts — fonte de verdade do backend
// (sprint-002/004). Mantidos aqui para uso tipado no front sem importar Deno.
// =====================================================================

/** Status de ingestao exposto ao front (mapeado de operacional/degradado/parado). */
export type StatusIngestao = "Saudavel" | "Atencao" | "Falha";

export interface HealthcheckResponse {
  statusIngestao: StatusIngestao;
  ultimaSync: string | null;
  totalAvisos: number;
  itensComErro: number;
}

/** Status persistido da execucao (coluna `execucoes.status`). */
export type ExecucaoStatus = "concluida" | "em_andamento" | "erro";

/**
 * Cursor/estado de retomada da execucao (execucoes.checkpoint). Presente nas
 * fontes coletadas em blocos (ex.: Nomus); null no Effecti monolitico.
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

/** Alias de dominio (secao 4.3): a tabela de erros consome `ErroIngestao[]`. */
export type ErroIngestao = Erro;

export interface ExecucoesResponse {
  items: Execucao[];
}

export interface ErrosResponse {
  items: Erro[];
}

/** Metadado de um chunk gerado para o aviso (presenca/dimensao do embedding). */
export interface ChunkMetadata {
  id: string;
  ordem: number | null;
  temEmbedding: boolean;
  dimensoes: number | null;
}

/** Metadado de um arquivo de edital tratado (sem texto extraido na listagem). */
export interface ArquivoMetadata {
  id: string;
  nomeArquivo: string | null;
  extensao: string | null;
  tamanhoBytes: number | null;
  storagePath: string | null;
  statusTratamento: string | null;
}

/** Estado do indice semantico do aviso (chunks, arquivos e status). */
export interface AvisoIndice {
  statusIndexacao: string | null;
  chunks: ChunkMetadata[];
  arquivos: ArquivoMetadata[];
}

/** GET /substrato/avisos/:id — detalhe completo do aviso (api-detalhe-edital). */
export interface AvisoDetalhe {
  id: string;
  conteudoVerbatim: string;
  payloadBruto: unknown;
  indice: AvisoIndice;
}

/** POST /substrato/avisos/:id/reindexar -> status do reprocesso do item. */
export interface ReprocessarResponse {
  status: "reprocessado" | "em_andamento" | "ignorado";
}

/** POST /ingestao/coletar -> execucao criada e pipeline disparado (202). */
export interface ColetaResponse {
  execucaoId: string;
  status: "em_andamento";
}

/** Corpo de erro padrao das Edge Functions (_shared/http.ts). */
export interface ApiErrorBody {
  error?: string;
  message?: string;
}

// =====================================================================
// Administracao — Fontes/credenciais e Configuracao da ingestao.
// Espelham os contratos das Edge Functions da sprint-003 (camelCase) e os
// snapshots lidos server-side (RLS) para hidratar os formularios.
// =====================================================================

/** Estado de conexao da fonte (fontes.estado_conexao). */
export type EstadoConexao = "conectada" | "erro" | "nao_configurada";

/** Frequencias suportadas (espelha _shared/validation.ts FREQUENCIAS). */
export type Frequencia = "manual" | "horaria" | "diaria" | "semanal" | "mensal";

/**
 * Snapshot da fonte Effecti lido server-side (RLS) para hidratar o cmp-cred-form.
 * NUNCA inclui o segredo: `configurado` deriva apenas da presenca da referencia
 * no Vault (token_cifrado != null); o token real jamais trafega ao cliente
 * (RNF-02). `ultimaVerificacao` vem de fontes.updated_at.
 */
export interface FonteEffectiState {
  nome: string;
  tipo: string;
  endpointBase: string;
  estadoConexao: EstadoConexao;
  configurado: boolean;
  ultimaVerificacao: string | null;
}

/** Snapshot da config de ingestao lido server-side para hidratar o cmp-cfg-form. */
export interface ConfigIngestaoState {
  janelaDias: number;
  modalidades: string[];
  portais: string[];
}

/**
 * Snapshot do agendamento GLOBAL do ciclo (singleton config_agendamento) lido
 * server-side para hidratar o cmp-agendamento-form. Governa a coleta de TODAS
 * as fontes (1 cron, orquestrador sequencial); cada fonte mantem so janela +
 * filtros. `horarioReferencia` e 'HH:MM' local (America/Sao_Paulo, UTC-3).
 */
export interface AgendamentoState {
  ativo: boolean;
  frequencia: Frequencia;
  horarioReferencia: string | null;
  diaSemana: number | null;
  diaMes: number | null;
  timezone: string;
}

/** PUT /fontes/effecti/credencial -> nunca retorna o segredo (RNF-02). */
export interface SalvarCredencialResponse {
  ok: boolean;
}

/** Causa especifica de falha do teste de conexao (copy distinta por causa). */
export type TestFailureCause = "timeout" | "unauthorized" | "rate_limited" | "unknown";

/**
 * POST /fontes/effecti/testar -> estado da conexao + latencia medida.
 * Em falha de teste o backend responde 200 com estadoConexao='erro' e
 * acompanha `causa`/`mensagem` para a UI exibir a copy correta.
 */
export interface TestarConexaoResponse {
  estadoConexao: EstadoConexao;
  latenciaMs: number;
  causa?: TestFailureCause;
  mensagem?: string;
}

/** PUT /ingestao/config -> confirmacao de persistencia. */
export interface SalvarConfigResponse {
  ok: boolean;
}

/**
 * PUT /agendamento/config -> confirma a persistencia e devolve o texto
 * resultante de aplicar_agendamento() (ex.: "agendado: 0 10 * * * (UTC)
 * freq=diaria" ou "ciclo desligado").
 */
export interface SalvarAgendamentoResponse {
  ok: boolean;
  agendamento: string | null;
}

/** Um resultado da busca semantica /v1: aviso resolvido + similaridade. */
export interface BuscaSemanticaResultItem {
  /** Id do aviso (avisos.id) ao qual o chunk mais similar pertence. */
  id: string;
  /** Similaridade de cosseno (1 - distancia); maior = mais relevante. */
  score: number;
  /** Conteudo verbatim integro do aviso (avisos.conteudo_verbatim). */
  verbatim: string;
}

/** POST /v1/substrato/busca-semantica -> top-K por similaridade de cosseno. */
export interface BuscaSemanticaResponse {
  results: BuscaSemanticaResultItem[];
}

// =====================================================================
// Fontes parametrizadas por tipo (Effecti | Nomus) — bloco Nomus na tela
// de Fontes. Espelham os contratos das Edge Functions (sprint-003/004):
// fontes-credencial, fontes-testar, ingestao-config e ingestao-coletar.
// Payloads viajam em snake_case; aqui o front trabalha em camelCase.
// =====================================================================

/** Tipo de fonte suportado (espelha _shared/validation.ts FONTES). */
export type FonteTipo = "effecti" | "nomus";

/**
 * Snapshot de credencial de uma fonte (hidratado server-side via RLS) para o
 * cmp-cred-form. Reaproveita a forma do Effecti: NUNCA inclui o segredo;
 * `configurado` deriva apenas da presenca da referencia no Vault (RNF-02).
 */
export type FonteCredState = FonteEffectiState;

/**
 * Linha resumida de public.fontes consumida pelo cmp-fonte-saude (useFontes).
 * Leitura direta da tabela via RLS do usuario autorizado (sem segredo).
 */
export interface Fonte {
  id: string;
  tipo: FonteTipo;
  estadoConexao: EstadoConexao;
  ativa: boolean;
  ordem: number;
  ultimaColetaEm: string | null;
}

/** Alias do contrato do teste de conexao (POST fontes-testar). */
export type TesteConexao = TestarConexaoResponse;

/**
 * Config por recurso (config_ingestao.recursos.<recurso>) em camelCase.
 * Governa o toggle de recurso e os tipos ativos por recurso (US-04/US-05).
 */
export interface RecursoConfig {
  ativo: boolean;
  tiposAtivos: string[];
  usaFiltroDataAlteracao?: boolean;
  etapasTerminais?: string[];
}

/** GET ingestao-config?fonte= -> config corrente da fonte (camelCase). */
export interface IngestaoConfig {
  fonte: FonteTipo;
  janelaDias: number | null;
  /** Aceita no backend mas NAO exposta na UI nesta entrega. */
  dataInicial: string | null;
  recursos: Record<string, RecursoConfig>;
}

/**
 * POST ingestao-coletar (Nomus) -> execucao criada (202) ou single-flight.
 * `jaEmAndamento` acompanha o 409 (ja existe coleta corrente).
 */
export interface ColetarResponse {
  execucaoId: string;
  estado: "em_andamento";
  jaEmAndamento?: boolean;
}
