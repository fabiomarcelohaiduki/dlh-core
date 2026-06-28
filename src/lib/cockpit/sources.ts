// =====================================================================
// cockpit/sources.ts — fontes de dado e métricas do cockpit (delta-16/18/19/29).
//
// COCKPIT_SOURCES descreve as fontes read-only que alimentam os cards de
// métrica do cockpit. Hoje há uma única fonte (`runs` = execucoes), lida em
// modo estritamente read-only (D-BE-04): o cockpit NUNCA dispara coleta nem
// muta execucoes — apenas consolida o que já existe.
//
// COCKPIT_METRIC_CATALOG oferece, por escopo de card, um conjunto de métricas
// SELECIONÁVEIS (delta-16/29). A escolha mora em `bloco_config.valor` e é
// resolvida por resolveMetric (selecionada ou a primeira do catálogo). Escopos
// sem métrica configurada caem no fallback honesto "Sem dado configurado"
// (renderCockpitCards). Tudo aqui é puro (sem I/O nem React): a leitura de fato
// roda no hook use-cockpit-metrics.
// =====================================================================

import type { AutomacaoConfig, Execucao, HealthcheckResponse } from "@/lib/api/types";
import type { PillState } from "@/lib/status";
import type { ScopeConfig } from "@/lib/engines/block-vis";
import { formatNumber } from "@/lib/format";

// ---------------------------------------------------------------------
// Fontes de dado read-only
// ---------------------------------------------------------------------

/** Identificador da fonte de dado de uma métrica do cockpit. */
export type CockpitSourceId = "runs" | "health" | "automacao";

/** Descritor de uma fonte de dado read-only do cockpit. */
export interface CockpitSource {
  id: CockpitSourceId;
  /** Rótulo humano da fonte (observabilidade/depuração). */
  label: string;
  /** Read-only: o cockpit jamais escreve nesta fonte (D-BE-04). */
  readonly: true;
}

/**
 * Registro estático das fontes do cockpit. `runs` = tabela execucoes;
 * `health` = healthcheck consolidado (totais do substrato, status da ingestão).
 */
export const COCKPIT_SOURCES: Readonly<Record<CockpitSourceId, CockpitSource>> = {
  runs: { id: "runs", label: "Execuções de ingestão", readonly: true },
  health: { id: "health", label: "Healthcheck do cockpit", readonly: true },
  automacao: { id: "automacao", label: "Config de triagem", readonly: true },
};

/** Dados read-only disponíveis para uma métrica computar. */
export interface MetricContext {
  runs: readonly Execucao[];
  health: HealthcheckResponse | null;
  automacao: AutomacaoConfig | null;
}

// ---------------------------------------------------------------------
// Métricas derivadas
// ---------------------------------------------------------------------

/** Valor computado de uma métrica: número + texto formatado + tom da pill. */
export interface MetricValue {
  value: number;
  display: string;
  tone: PillState;
}

/** Definição de uma métrica selecionável dentro de um escopo de card. */
export interface CockpitMetricDef {
  /** id estável da métrica no escopo (persistido em bloco_config.valor). */
  id: string;
  /** rótulo curto exibido no card e no select de configuração. */
  label: string;
  /** fonte de dado read-only consumida. */
  source: CockpitSourceId;
  /** deriva o valor a partir dos dados read-only já carregados. */
  compute(ctx: MetricContext): MetricValue;
}

/** True quando o ISO cai no dia local de hoje. */
function isHoje(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.toDateString() === new Date().toDateString();
}

// Métricas reutilizáveis derivadas das execucoes (fonte runs).
const M_EXEC_HOJE: CockpitMetricDef = {
  id: "exec-hoje",
  label: "Execuções hoje",
  source: "runs",
  compute: ({ runs }) => {
    const n = runs.filter((r) => isHoje(r.inicio)).length;
    return { value: n, display: String(n), tone: n > 0 ? "ok" : "idle" };
  },
};
const M_EM_EXECUCAO: CockpitMetricDef = {
  id: "em-execucao",
  label: "Em execução",
  source: "runs",
  compute: ({ runs }) => {
    const n = runs.filter((r) => r.status === "em_andamento").length;
    return { value: n, display: String(n), tone: n > 0 ? "run" : "idle" };
  },
};
const M_COM_ERRO: CockpitMetricDef = {
  id: "com-erro",
  label: "Com erro",
  source: "runs",
  compute: ({ runs }) => {
    const n = runs.filter((r) => r.status === "erro").length;
    return { value: n, display: String(n), tone: n > 0 ? "warn" : "ok" };
  },
};
const M_CONCLUIDAS: CockpitMetricDef = {
  id: "concluidas",
  label: "Concluídas",
  source: "runs",
  compute: ({ runs }) => {
    const n = runs.filter((r) => r.status === "concluida").length;
    return { value: n, display: String(n), tone: "ok" };
  },
};

// Métrica do módulo Cadastros: total do substrato (avisos + processos +
// pessoas), lido do healthcheck. Sem leitura ainda -> idle (sem cor forte).
const M_CADASTROS_TOTAL: CockpitMetricDef = {
  id: "cadastros-total",
  label: "Cadastros",
  source: "health",
  compute: ({ health }) => {
    if (!health) return { value: 0, display: "…", tone: "idle" };
    const n = health.totalAvisos + health.totalProcessos + health.totalPessoas;
    return { value: n, display: formatNumber(n), tone: n > 0 ? "ok" : "idle" };
  },
};

// Métrica do módulo Automações: estado de execução da triagem (modo da IA),
// lido da config singleton. Autônoma = a triagem roda sozinha (verde); Lion =
// execução manual pelo agente (neutro). Sem leitura ainda -> idle.
const M_AUTOMACAO_TRIAGEM: CockpitMetricDef = {
  id: "automacao-triagem",
  label: "Triagem",
  source: "automacao",
  compute: ({ automacao }) => {
    if (!automacao) return { value: 0, display: "…", tone: "idle" };
    const autonoma = automacao.modoExecucaoIa === "autonoma";
    return {
      value: autonoma ? 1 : 0,
      display: autonoma ? "Autônoma" : "Manual",
      tone: autonoma ? "ok" : "idle",
    };
  },
};

/**
 * Catálogo de métricas por escopo (delta-16/29). Cada escopo de card oferece um
 * conjunto de métricas selecionáveis; a primeira é o padrão. Apenas escopos com
 * fonte real (execucoes) têm catálogo — os demais caem no fallback honesto
 * "Sem dado configurado" no card e no select desabilitado da configuração.
 */
export const COCKPIT_METRIC_CATALOG: Readonly<
  Record<string, readonly CockpitMetricDef[]>
> = {
  ingestao: [M_EXEC_HOJE, M_EM_EXECUCAO, M_COM_ERRO, M_CONCLUIDAS],
  "ingestao.coleta": [M_EM_EXECUCAO, M_EXEC_HOJE, M_COM_ERRO],
  "ingestao.erros": [M_COM_ERRO, M_EXEC_HOJE, M_CONCLUIDAS],
  cadastros: [M_CADASTROS_TOTAL],
  automacoes: [M_AUTOMACAO_TRIAGEM],
};

/** Métricas disponíveis para um escopo (vazio quando sem fonte configurada). */
export function metricsForScope(escopo: string): readonly CockpitMetricDef[] {
  return COCKPIT_METRIC_CATALOG[escopo] ?? [];
}

/**
 * Resolve a métrica efetiva de um escopo: a selecionada (`selectedId`, vinda de
 * bloco_config.valor) ou a primeira do catálogo. `null` quando o escopo não tem
 * catálogo — o card cai no estado honesto "Sem dado configurado".
 */
export function resolveMetric(
  escopo: string,
  selectedId?: string | null,
): CockpitMetricDef | null {
  const cat = metricsForScope(escopo);
  if (cat.length === 0) return null;
  return cat.find((m) => m.id === selectedId) ?? cat[0];
}

// ---------------------------------------------------------------------
// Escopos de card (módulos e submódulos)
// ---------------------------------------------------------------------

/** Definição de um escopo de card do cockpit. */
export interface CockpitScopeDef {
  escopo: string;
  label: string;
  /** descrição curta exibida na configuração dos cards. */
  desc: string;
  /** módulo pai (submódulo) ou null (card de módulo). */
  parent: string | null;
}

/**
 * Escopos canônicos dos cards do cockpit. Cards de módulo nascem visíveis;
 * submódulos nascem ocultos (default: módulos on, submódulos off).
 */
export const COCKPIT_SCOPES: readonly CockpitScopeDef[] = [
  {
    escopo: "ingestao",
    label: "Ingestão",
    desc: "Card do módulo de ingestão no cockpit.",
    parent: null,
  },
  {
    escopo: "ingestao.coleta",
    label: "Coleta",
    desc: "Ingestão › Coleta.",
    parent: "ingestao",
  },
  {
    escopo: "ingestao.erros",
    label: "Erros",
    desc: "Ingestão › Erros.",
    parent: "ingestao",
  },
  {
    escopo: "cadastros",
    label: "Cadastros",
    desc: "Card do módulo de cadastros no cockpit.",
    parent: null,
  },
  {
    escopo: "automacoes",
    label: "Automações",
    desc: "Card do módulo de automações no cockpit.",
    parent: null,
  },
];

/**
 * discoverCockpitScopes — descobre os escopos a renderizar em `.metrics`,
 * aplicando os defaults (módulos on, submódulos off) e a ordem persistida em
 * bloco_config (tipo card). Mantém a ordem de catálogo como desempate estável.
 */
export function discoverCockpitScopes(cfg: ScopeConfig): CockpitScopeDef[] {
  return COCKPIT_SCOPES.map((s, idx) => ({
    s,
    idx,
    on: cfg.isOn(s.escopo, s.parent === null),
    ordem: cfg.ordemOf(s.escopo, idx),
  }))
    .filter((x) => x.on)
    .sort((a, b) => a.ordem - b.ordem || a.idx - b.idx)
    .map((x) => x.s);
}
