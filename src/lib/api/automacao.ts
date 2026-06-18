// =====================================================================
// Camada de API do modulo Automacao (triagem). Consome as Edge Functions
// automacao-* via apiFetch (/proxy) + buildQuery, no padrao client.ts
// (ApiError). Responsabilidade unica desta camada: mapear o snake_case dos
// endpoints para o camelCase do client (contrato 4.3). Erros tratados via
// ApiError pelo proprio apiFetch.
// =====================================================================

import { apiFetch, buildQuery } from "@/lib/api/client";
import type {
  AgenteConfig,
  AutomacaoConfig,
  BacktestRecall,
  ExemploFewShot,
  FalsoDescarteAmostra,
  FeedbackHumano,
  LixeiraItem,
  RegraDura,
  TriagemItem,
  Veredito,
} from "@/lib/api/types";

// ---------------------------------------------------------------------
// Shapes de transporte (snake_case) recebidos das Edge Functions.
// ---------------------------------------------------------------------

interface RawTriagemItem {
  aviso_id: string;
  objeto: string;
  orgao: string;
  uf: string;
  data: string | null;
  veredito: string | null;
  confianca: number | null;
  motivo: string | null;
  produto_candidato: string | null;
  feedback_humano: string | null;
  na_lixeira: boolean;
  na_lixeira_em: string | null;
  descarte_previsto_em: string | null;
  reabilitado: boolean;
}

interface RawAvisosResponse {
  itens: RawTriagemItem[];
  descarte_fisico_ligado: boolean;
  dias_carencia: number;
  next_cursor: string | null;
}

interface RawRegra {
  id: string;
  tipo: string;
  termo: string;
  ativo: boolean;
  criado_em: string;
}

interface RawConfig {
  dias_carencia: number;
  limiar_inferior: number;
  limiar_superior: number;
  k_few_shot: number;
  descarte_fisico_ligado: boolean;
  modo_execucao_ia: string;
  atualizado_em: string | null;
}

interface RawAgenteConfig {
  ativo: boolean;
  nome: string;
  persona_prompt: string;
  ferramentas: string[];
  versao: number;
  atualizado_em: string | null;
}

interface RawExemplo {
  id: string;
  texto: string;
  veredito_rotulado: string | null;
  ativo: boolean;
  aviso_id: string | null;
  decisao_id: string | null;
  criado_em: string;
}

interface RawExemplosResponse {
  itens: RawExemplo[];
  next_cursor: string | null;
}

interface RawFalsoDescarte {
  aviso_id: string;
  objeto: string;
  veredito: string;
  confianca: number | null;
  nomus_processo_ref: string;
}

interface RawBacktest {
  periodo: { desde: string; ate: string };
  processos_nomus_reais: number;
  casados_com_aviso: number;
  preservados_pela_triagem: number;
  descartados_indevidamente: number;
  recall: number | null;
  descarte_fisico_ligado: boolean;
  amostras_falso_descarte: RawFalsoDescarte[];
}

interface RawFeedbackResponse {
  aviso_id: string;
  feedback_humano: string;
  exemplo_id: string;
  veredito_avaliado: string;
  veredito_rotulado: string;
}

// ---------------------------------------------------------------------
// Mapeadores snake_case -> camelCase (contrato 4.3).
// ---------------------------------------------------------------------

function toTriagemItem(raw: RawTriagemItem): TriagemItem {
  return {
    avisoId: raw.aviso_id,
    objeto: raw.objeto,
    orgao: raw.orgao,
    uf: raw.uf,
    data: raw.data ?? "",
    veredito: (raw.veredito as Veredito | null) ?? null,
    confianca: raw.confianca ?? null,
    motivo: raw.motivo ?? null,
    produtoCandidato: raw.produto_candidato ?? null,
    feedbackHumano: (raw.feedback_humano as FeedbackHumano | null) ?? null,
    naLixeira: raw.na_lixeira === true,
    naLixeiraEm: raw.na_lixeira_em ?? null,
    descartePrevistoEm: raw.descarte_previsto_em ?? null,
    reabilitado: raw.reabilitado === true,
  };
}

function toRegra(raw: RawRegra): RegraDura {
  return {
    id: raw.id,
    tipo: raw.tipo as RegraDura["tipo"],
    termo: raw.termo,
    ativo: raw.ativo === true,
    criadoEm: raw.criado_em,
  };
}

function toConfig(raw: RawConfig): AutomacaoConfig {
  return {
    diasCarencia: raw.dias_carencia,
    limiarInferior: raw.limiar_inferior,
    limiarSuperior: raw.limiar_superior,
    kFewShot: raw.k_few_shot,
    descarteFisicoLigado: raw.descarte_fisico_ligado === true,
    modoExecucaoIa: (raw.modo_execucao_ia === "autonoma" ? "autonoma" : "lion"),
    atualizadoEm: raw.atualizado_em ?? "",
  };
}

function toAgenteConfig(raw: RawAgenteConfig): AgenteConfig {
  return {
    ativo: raw.ativo === true,
    nome: raw.nome,
    personaPrompt: raw.persona_prompt,
    ferramentas: Array.isArray(raw.ferramentas) ? raw.ferramentas : [],
    versao: raw.versao,
    atualizadoEm: raw.atualizado_em ?? "",
  };
}

function toExemplo(raw: RawExemplo): ExemploFewShot {
  return {
    id: raw.id,
    texto: raw.texto,
    vereditoRotulado: (raw.veredito_rotulado as Veredito) ?? "lixo",
    ativo: raw.ativo === true,
    avisoId: raw.aviso_id ?? null,
    decisaoId: raw.decisao_id ?? null,
    criadoEm: raw.criado_em,
  };
}

function toFalsoDescarte(raw: RawFalsoDescarte): FalsoDescarteAmostra {
  return {
    avisoId: raw.aviso_id,
    objeto: raw.objeto,
    veredito: raw.veredito as Veredito,
    confianca: raw.confianca ?? null,
    nomusProcessoRef: raw.nomus_processo_ref,
  };
}

function toBacktest(raw: RawBacktest): BacktestRecall {
  return {
    periodo: raw.periodo,
    processosNomusReais: raw.processos_nomus_reais,
    casadosComAviso: raw.casados_com_aviso,
    preservadosPelaTriagem: raw.preservados_pela_triagem,
    descartadosIndevidamente: raw.descartados_indevidamente,
    recall: raw.recall ?? null,
    descarteFisicoLigado: raw.descarte_fisico_ligado === true,
    amostrasFalsoDescarte: (raw.amostras_falso_descarte ?? []).map(toFalsoDescarte),
  };
}

// ---------------------------------------------------------------------
// Resultados/inputs em camelCase expostos aos hooks.
// ---------------------------------------------------------------------

/** Pagina da fila de triagem (e da lixeira: mesma forma). */
export interface AvisosPage<T = TriagemItem> {
  itens: T[];
  descarteFisicoLigado: boolean;
  diasCarencia: number;
  nextCursor: string | null;
}

/** Filtros da listagem de avisos triados (automacao-avisos). */
export interface ListTriagemParams {
  veredito?: "util" | "duvida" | "lixo" | "todos";
  limite?: number;
  cursor?: string;
}

/** Filtros da listagem da lixeira (automacao-avisos?lixeira=true). */
export interface ListLixeiraParams {
  limite?: number;
  cursor?: string;
}

export interface FeedbackInput {
  avisoId: string;
  feedback: FeedbackHumano;
  /** Obrigatorio quando feedback = "incorreto" (veredito correto segundo o humano). */
  rotuloCorreto?: Veredito;
}

export interface FeedbackResult {
  avisoId: string;
  feedbackHumano: FeedbackHumano;
  exemploId: string;
  vereditoAvaliado: Veredito;
  vereditoRotulado: Veredito;
}

export interface CreateRegraInput {
  tipo: RegraDura["tipo"];
  termo: string;
  ativo: boolean;
}

export interface UpdateRegraInput {
  id: string;
  termo: string;
  ativo: boolean;
}

export interface AutomacaoConfigInput {
  diasCarencia: number;
  limiarInferior: number;
  limiarSuperior: number;
  kFewShot: number;
  descarteFisicoLigado: boolean;
}

export interface AgenteConfigInput {
  ativo: boolean;
  nome: string;
  personaPrompt: string;
  ferramentas: string[];
}

/** Filtros da curadoria de exemplos few-shot (automacao-exemplos). */
export interface ListExemplosParams {
  veredito?: "util" | "duvida" | "lixo" | "todos";
  ativo?: boolean;
  limite?: number;
  cursor?: string;
}

export interface ExemplosPage {
  itens: ExemploFewShot[];
  nextCursor: string | null;
}

/** Periodo (ISO8601 date) do backtest de recall. */
export interface BacktestParams {
  desde?: string;
  ate?: string;
}

// ---------------------------------------------------------------------
// Triagem (aba Triagem + Lixeira) — automacao-avisos.
// ---------------------------------------------------------------------

/** Lista os avisos ja triados (inclui lixo), filtravel por veredito. */
export async function listTriagem(
  params: ListTriagemParams = {},
): Promise<AvisosPage<TriagemItem>> {
  const raw = await apiFetch<RawAvisosResponse>(
    `automacao-avisos${buildQuery(params)}`,
    { method: "GET" },
  );
  return {
    itens: (raw.itens ?? []).map(toTriagemItem),
    descarteFisicoLigado: raw.descarte_fisico_ligado === true,
    diasCarencia: raw.dias_carencia,
    nextCursor: raw.next_cursor ?? null,
  };
}

/** Lista os avisos atualmente na lixeira (filtro lixeira aplicado no servidor). */
export async function listLixeira(
  params: ListLixeiraParams = {},
): Promise<AvisosPage<LixeiraItem>> {
  const raw = await apiFetch<RawAvisosResponse>(
    `automacao-avisos${buildQuery({ ...params, lixeira: true })}`,
    { method: "GET" },
  );
  return {
    itens: (raw.itens ?? []).map(toTriagemItem),
    descarteFisicoLigado: raw.descarte_fisico_ligado === true,
    diasCarencia: raw.dias_carencia,
    nextCursor: raw.next_cursor ?? null,
  };
}

// ---------------------------------------------------------------------
// Feedback humano — automacao-feedback.
// ---------------------------------------------------------------------

/** Grava feedback (correto/incorreto) na decisao vigente e gera o exemplo rotulado. */
export async function sendFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  const raw = await apiFetch<RawFeedbackResponse>("automacao-feedback", {
    method: "POST",
    body: JSON.stringify({
      aviso_id: input.avisoId,
      feedback: input.feedback,
      rotulo_correto: input.rotuloCorreto ?? null,
    }),
  });
  return {
    avisoId: raw.aviso_id,
    feedbackHumano: raw.feedback_humano as FeedbackHumano,
    exemploId: raw.exemplo_id,
    vereditoAvaliado: raw.veredito_avaliado as Veredito,
    vereditoRotulado: raw.veredito_rotulado as Veredito,
  };
}

// ---------------------------------------------------------------------
// Regras duras (CRUD) — automacao-regras.
// ---------------------------------------------------------------------

export async function listRegras(): Promise<{ regras: RegraDura[] }> {
  const raw = await apiFetch<{ regras: RawRegra[] }>("automacao-regras", {
    method: "GET",
  });
  return { regras: (raw.regras ?? []).map(toRegra) };
}

export function createRegra(input: CreateRegraInput): Promise<{ id: string; ok: boolean }> {
  return apiFetch<{ id: string; ok: boolean }>("automacao-regras", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateRegra(input: UpdateRegraInput): Promise<{ id: string; ok: boolean }> {
  return apiFetch<{ id: string; ok: boolean }>("automacao-regras", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteRegra(id: string): Promise<{ id: string; ok: boolean }> {
  return apiFetch<{ id: string; ok: boolean }>("automacao-regras", {
    method: "DELETE",
    body: JSON.stringify({ id }),
  });
}

// ---------------------------------------------------------------------
// Config singleton — automacao-config.
// ---------------------------------------------------------------------

export async function getAutomacaoConfig(): Promise<AutomacaoConfig> {
  const raw = await apiFetch<RawConfig>("automacao-config", { method: "GET" });
  return toConfig(raw);
}

export async function updateAutomacaoConfig(
  input: AutomacaoConfigInput,
): Promise<AutomacaoConfig> {
  const raw = await apiFetch<RawConfig>("automacao-config", {
    method: "PUT",
    body: JSON.stringify({
      dias_carencia: input.diasCarencia,
      limiar_inferior: input.limiarInferior,
      limiar_superior: input.limiarSuperior,
      k_few_shot: input.kFewShot,
      descarte_fisico_ligado: input.descarteFisicoLigado,
    }),
  });
  return toConfig(raw);
}

// ---------------------------------------------------------------------
// Persona do subagente especialista (E15) — automacao-agente-config.
// ---------------------------------------------------------------------

export async function getAgenteConfig(): Promise<AgenteConfig> {
  const raw = await apiFetch<RawAgenteConfig>("automacao-agente-config", {
    method: "GET",
  });
  return toAgenteConfig(raw);
}

export async function updateAgenteConfig(input: AgenteConfigInput): Promise<AgenteConfig> {
  const raw = await apiFetch<RawAgenteConfig>("automacao-agente-config", {
    method: "PUT",
    body: JSON.stringify({
      ativo: input.ativo,
      nome: input.nome,
      persona_prompt: input.personaPrompt,
      ferramentas: input.ferramentas,
    }),
  });
  return toAgenteConfig(raw);
}

// ---------------------------------------------------------------------
// Curadoria do acervo few-shot (E14) — automacao-exemplos.
// ---------------------------------------------------------------------

export async function listExemplos(
  params: ListExemplosParams = {},
): Promise<ExemplosPage> {
  const raw = await apiFetch<RawExemplosResponse>(
    `automacao-exemplos${buildQuery(params)}`,
    { method: "GET" },
  );
  return {
    itens: (raw.itens ?? []).map(toExemplo),
    nextCursor: raw.next_cursor ?? null,
  };
}

/** Alterna `ativo` de um exemplo (soft-delete reversivel). */
export function toggleExemplo(
  id: string,
  ativo: boolean,
): Promise<{ id: string; ok: boolean }> {
  return apiFetch<{ id: string; ok: boolean }>("automacao-exemplos", {
    method: "PATCH",
    body: JSON.stringify({ id, ativo }),
  });
}

/** Remove fisicamente um exemplo ruim do acervo. */
export function deleteExemplo(id: string): Promise<{ id: string; ok: boolean }> {
  return apiFetch<{ id: string; ok: boolean }>("automacao-exemplos", {
    method: "DELETE",
    body: JSON.stringify({ id }),
  });
}

// ---------------------------------------------------------------------
// Backtest de recall (modo sombra) — automacao-backtest-recall.
// ---------------------------------------------------------------------

export async function getBacktestRecall(
  params: BacktestParams = {},
): Promise<BacktestRecall> {
  const raw = await apiFetch<RawBacktest>(
    `automacao-backtest-recall${buildQuery(params)}`,
    { method: "GET" },
  );
  return toBacktest(raw);
}
