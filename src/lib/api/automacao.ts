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
  AvisoItens,
  BacktestRecall,
  Conhecimento,
  ExemploFewShot,
  ExtracaoStatus,
  ExtracaoSuspeitaCurarInput,
  ExtracaoSuspeitaFilaItem,
  FalsoDescarteAmostra,
  FeedbackHumano,
  ItensStatus,
  LixeiraItem,
  MatchFeedbackFilaItem,
  MatchFeedbackInput,
  RegraDura,
  TriagemItem,
  Veredito,
} from "@/lib/api/types";

// ---------------------------------------------------------------------
// Shapes de transporte (snake_case) recebidos das Edge Functions.
// ---------------------------------------------------------------------

interface RawTriagemItem {
  aviso_id: string;
  effecti_id: string | null;
  edital: string | null;
  portal: string | null;
  uasg: string | null;
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
  extracao: string;
}

interface RawAvisosResponse {
  itens: RawTriagemItem[];
  descarte_fisico_ligado: boolean;
  dias_carencia: number;
  next_cursor: string | null;
}

interface RawFilaResponse {
  itens: RawTriagemItem[];
  total: number;
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
  triar_apenas_futuros: boolean;
  triagem_horizonte_dias: number;
  modo_execucao_ia: string;
  atualizado_em: string | null;
}

interface RawAgenteConfig {
  ativo: boolean;
  nome: string;
  persona_prompt: string;
  instrucoes_operacionais: string;
  versao: number;
  atualizado_em: string | null;
}

interface RawConhecimento {
  id: string;
  setor: string;
  titulo: string;
  conteudo: string;
  ativo: boolean;
  ordem: number;
  versao: number;
  atualizado_em: string | null;
}

interface RawConhecimentosResponse {
  items: RawConhecimento[];
  total: number;
  limit: number;
  offset: number;
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
    effectiId: raw.effecti_id ?? null,
    edital: raw.edital ?? null,
    portal: raw.portal ?? null,
    uasg: raw.uasg ?? null,
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
    extracao: (raw.extracao as ExtracaoStatus) ?? "sem_documento",
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
    triarApenasFuturos: raw.triar_apenas_futuros === true,
    triagemHorizonteDias: raw.triagem_horizonte_dias ?? 0,
    modoExecucaoIa: (raw.modo_execucao_ia === "autonoma" ? "autonoma" : "lion"),
    atualizadoEm: raw.atualizado_em ?? "",
  };
}

function toAgenteConfig(raw: RawAgenteConfig): AgenteConfig {
  return {
    ativo: raw.ativo === true,
    nome: raw.nome,
    personaPrompt: raw.persona_prompt,
    instrucoesOperacionais: raw.instrucoes_operacionais ?? "",
    versao: raw.versao,
    atualizadoEm: raw.atualizado_em ?? "",
  };
}

function toConhecimento(raw: RawConhecimento): Conhecimento {
  return {
    id: raw.id,
    setor: raw.setor,
    titulo: raw.titulo,
    conteudo: raw.conteudo,
    ativo: raw.ativo === true,
    ordem: typeof raw.ordem === "number" ? raw.ordem : 0,
    versao: typeof raw.versao === "number" ? raw.versao : 1,
    atualizadoEm: raw.atualizado_em ?? null,
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

/** Filtros da fila de avisos aguardando triagem (automacao-avisos?fila=true). */
export interface ListFilaParams {
  limite?: number;
  cursor?: string;
}

/** Pagina da fila (aguardando triagem) + total da fila inteira. */
export interface FilaPage {
  itens: TriagemItem[];
  total: number;
  nextCursor: string | null;
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
  triarApenasFuturos: boolean;
  triagemHorizonteDias: number;
}

export interface AgenteConfigInput {
  ativo: boolean;
  nome: string;
  personaPrompt: string;
  instrucoesOperacionais: string;
}

export interface ListConhecimentosParams {
  setor: string;
  ativo?: boolean;
  limit?: number;
}

export interface CreateConhecimentoInput {
  setor: string;
  titulo: string;
  conteudo: string;
  ativo: boolean;
  ordem?: number;
}

export interface UpdateConhecimentoInput {
  id: string;
  titulo: string;
  conteudo: string;
  ativo: boolean;
  ordem?: number;
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

/** Lista os avisos aguardando triagem (fila FIFO) + total da fila inteira. */
export async function listFila(params: ListFilaParams = {}): Promise<FilaPage> {
  const raw = await apiFetch<RawFilaResponse>(
    `automacao-avisos${buildQuery({ ...params, fila: true })}`,
    { method: "GET" },
  );
  return {
    itens: (raw.itens ?? []).map(toTriagemItem),
    total: raw.total ?? 0,
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
// Itens extraidos por aviso (recall por item) — automacao-aviso-itens.
// ---------------------------------------------------------------------

interface RawAvisoDocumento {
  documento_id: string;
  nome_arquivo: string | null;
  itens_status: string;
  ocr_baixa_confianca?: boolean;
}

interface RawAvisoItem {
  id: string;
  documento_id: string;
  lista_origem: string;
  fonte_descricao: string;
  item_numero: string | null;
  lote: string | null;
  descricao: string;
  unidade: string | null;
  quantidade: number | null;
  preco_referencia: number | null;
  ordem: number | null;
  item_estado?: string | null;
  item_origem?: string | null;
  suspeito_motivo?: string | null;
  effecti?: boolean;
}

interface RawAvisoItemMatch {
  documento_item_id: string;
  produto_id: string | null;
  sku_id: string | null;
  codigo_sku: string | null;
  produto_nome: string | null;
  score: number | null;
}

interface RawRecallEffecti {
  numero_suspeito: string | null;
  item_descricao: string | null;
}

interface RawAvisoItensResponse {
  documentos: RawAvisoDocumento[];
  itens: RawAvisoItem[];
  matches: RawAvisoItemMatch[];
  recall_effecti?: RawRecallEffecti[];
}

/** Documentos + itens extraidos de um aviso (so leitura; a Lia extrai). */
export async function getAvisoItens(avisoId: string): Promise<AvisoItens> {
  const raw = await apiFetch<RawAvisoItensResponse>(
    `automacao-aviso-itens${buildQuery({ aviso_id: avisoId })}`,
    { method: "GET" },
  );
  return {
    documentos: (raw.documentos ?? []).map((d) => ({
      documentoId: d.documento_id,
      nomeArquivo: d.nome_arquivo ?? null,
      itensStatus: (d.itens_status ?? "pendente") as ItensStatus,
      ocrBaixaConfianca: d.ocr_baixa_confianca ?? false,
    })),
    itens: (raw.itens ?? []).map((i) => ({
      id: i.id,
      documentoId: i.documento_id,
      listaOrigem: i.lista_origem ?? "principal",
      fonteDescricao: i.fonte_descricao ?? "tecnica",
      itemNumero: i.item_numero ?? null,
      lote: i.lote ?? null,
      descricao: i.descricao,
      unidade: i.unidade ?? null,
      quantidade: i.quantidade ?? null,
      precoReferencia: i.preco_referencia ?? null,
      ordem: i.ordem ?? null,
      itemEstado: i.item_estado ?? "revisado",
      itemOrigem: i.item_origem ?? null,
      suspeitoMotivo: i.suspeito_motivo ?? null,
      effecti: i.effecti ?? false,
    })),
    matches: (raw.matches ?? []).map((m) => ({
      documentoItemId: m.documento_item_id,
      produtoId: m.produto_id ?? null,
      skuId: m.sku_id ?? null,
      skuCodigo: m.codigo_sku ?? null,
      produtoNome: m.produto_nome ?? null,
      score: m.score ?? null,
    })),
    recallEffecti: (raw.recall_effecti ?? []).map((r) => ({
      numeroSuspeito: r.numero_suspeito ?? null,
      itemDescricao: r.item_descricao ?? null,
    })),
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
// Feedback de match (item x produto/SKU) — v1-triagem-match-feedback.
// ---------------------------------------------------------------------

interface RawMatchFeedbackFilaItem {
  id: string;
  aviso_id: string;
  documento_item_id: string;
  item_descricao: string | null;
  acao: MatchFeedbackFilaItem["acao"];
  produto_sugerido_nome: string | null;
  sku_sugerido_codigo: string | null;
  produto_correto_nome: string | null;
  sku_correto_codigo: string | null;
  motivo: string;
  status: string;
  autor: string | null;
  created_at: string;
}

/** Grava/atualiza a correcao humana de um match (upsert por aviso+item). */
export async function sendMatchFeedback(input: MatchFeedbackInput): Promise<{ id: string }> {
  const raw = await apiFetch<{ id: string; ok: boolean }>("v1-triagem-match-feedback", {
    method: "POST",
    body: JSON.stringify({
      aviso_id: input.avisoId,
      documento_item_id: input.documentoItemId,
      acao: input.acao,
      item_descricao: input.itemDescricao ?? null,
      produto_sugerido_id: input.produtoSugeridoId ?? null,
      sku_sugerido_id: input.skuSugeridoId ?? null,
      produto_sugerido_nome: input.produtoSugeridoNome ?? null,
      produto_correto_id: input.produtoCorretoId ?? null,
      sku_correto_id: input.skuCorretoId ?? null,
      motivo: input.motivo,
    }),
  });
  return { id: raw.id };
}

/** Lista a fila de feedback de match (default status=pendente). */
export async function listMatchFeedbackFila(
  status: string = "pendente",
): Promise<{ itens: MatchFeedbackFilaItem[] }> {
  const raw = await apiFetch<{ itens: RawMatchFeedbackFilaItem[] }>(
    `v1-triagem-match-feedback${buildQuery({ status })}`,
    { method: "GET" },
  );
  return {
    itens: (raw.itens ?? []).map((i) => ({
      id: i.id,
      avisoId: i.aviso_id,
      documentoItemId: i.documento_item_id,
      itemDescricao: i.item_descricao ?? null,
      acao: i.acao,
      produtoSugeridoNome: i.produto_sugerido_nome ?? null,
      skuSugeridoCodigo: i.sku_sugerido_codigo ?? null,
      produtoCorretoNome: i.produto_correto_nome ?? null,
      skuCorretoCodigo: i.sku_correto_codigo ?? null,
      motivo: i.motivo,
      status: i.status,
      autor: i.autor ?? null,
      criadoEm: i.created_at,
    })),
  };
}

// ---------------------------------------------------------------------
// Fila de revisao de EXTRACAO (fidelidade / recall) — automacao-extracao-suspeitas.
// ---------------------------------------------------------------------

interface RawExtracaoSuspeitaFilaItem {
  id: string;
  aviso_id: string | null;
  documento_id: string | null;
  documento_item_id: string | null;
  tipo: ExtracaoSuspeitaFilaItem["tipo"];
  item_descricao: string | null;
  numero_suspeito: string | null;
  motivo: string;
  status: string;
  autor: string | null;
  descricao_corrigida: string | null;
  numero_corrigido: string | null;
  curado_por: string | null;
  curado_em: string | null;
  created_at: string;
  aviso_objeto: string | null;
  documento_nome: string | null;
}

/** Lista a fila de suspeitas de extracao (default status=pendente). */
export async function listExtracaoSuspeitasFila(
  status: string = "pendente",
): Promise<{ itens: ExtracaoSuspeitaFilaItem[] }> {
  const raw = await apiFetch<{ itens: RawExtracaoSuspeitaFilaItem[] }>(
    `automacao-extracao-suspeitas${buildQuery({ status })}`,
    { method: "GET" },
  );
  return {
    itens: (raw.itens ?? []).map((i) => ({
      id: i.id,
      avisoId: i.aviso_id ?? null,
      documentoId: i.documento_id ?? null,
      documentoItemId: i.documento_item_id ?? null,
      tipo: i.tipo,
      itemDescricao: i.item_descricao ?? null,
      numeroSuspeito: i.numero_suspeito ?? null,
      motivo: i.motivo,
      status: i.status,
      autor: i.autor ?? null,
      descricaoCorrigida: i.descricao_corrigida ?? null,
      numeroCorrigido: i.numero_corrigido ?? null,
      curadoPor: i.curado_por ?? null,
      curadoEm: i.curado_em ?? null,
      criadoEm: i.created_at,
      avisoObjeto: i.aviso_objeto ?? null,
      documentoNome: i.documento_nome ?? null,
    })),
  };
}

/** Cura uma suspeita de extracao (confirmar / corrigir / descartar). */
export async function curarExtracaoSuspeita(
  input: ExtracaoSuspeitaCurarInput,
): Promise<{ id: string; status: string }> {
  const raw = await apiFetch<{ id: string; status: string; ok: boolean }>(
    "automacao-extracao-suspeitas",
    {
      method: "POST",
      body: JSON.stringify({
        id: input.id,
        acao: input.acao,
        descricao_corrigida: input.descricaoCorrigida ?? null,
        numero_corrigido: input.numeroCorrigido ?? null,
      }),
    },
  );
  return { id: raw.id, status: raw.status };
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
      triar_apenas_futuros: input.triarApenasFuturos,
      triagem_horizonte_dias: input.triagemHorizonteDias,
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
      instrucoes_operacionais: input.instrucoesOperacionais,
    }),
  });
  return toAgenteConfig(raw);
}

// ---------------------------------------------------------------------
// Base de conhecimento por setor (entregue pela FILA) — conhecimentos.
// ---------------------------------------------------------------------

export async function listConhecimentos(
  params: ListConhecimentosParams,
): Promise<Conhecimento[]> {
  const raw = await apiFetch<RawConhecimentosResponse>(
    `conhecimentos${buildQuery({ setor: params.setor, ativo: params.ativo, limit: params.limit ?? 200 })}`,
    { method: "GET" },
  );
  return (raw.items ?? []).map(toConhecimento);
}

export async function createConhecimento(
  input: CreateConhecimentoInput,
): Promise<Conhecimento> {
  const raw = await apiFetch<RawConhecimento>("conhecimentos", {
    method: "POST",
    body: JSON.stringify({
      setor: input.setor,
      titulo: input.titulo,
      conteudo: input.conteudo,
      ativo: input.ativo,
      ...(input.ordem !== undefined ? { ordem: input.ordem } : {}),
    }),
  });
  return toConhecimento(raw);
}

export async function updateConhecimento(
  input: UpdateConhecimentoInput,
): Promise<Conhecimento> {
  const raw = await apiFetch<RawConhecimento>(`conhecimentos/${input.id}`, {
    method: "PUT",
    body: JSON.stringify({
      titulo: input.titulo,
      conteudo: input.conteudo,
      ativo: input.ativo,
      ...(input.ordem !== undefined ? { ordem: input.ordem } : {}),
    }),
  });
  return toConhecimento(raw);
}

export function deleteConhecimento(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`conhecimentos/${id}`, { method: "DELETE" });
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
