"use client";

// =====================================================================
// cockpit-metrics — renderCockpitCards: a seção `.metrics` do cockpit (delta-16/29).
//
// Descobre os escopos ativos (discoverCockpitScopes) a partir de bloco_config
// (tipo card) e preenche a grade auto-fit `.metrics` com um card por escopo.
// Cada card resolve sua métrica via resolveMetric — respeitando a métrica
// escolhida na configuração (bloco_config.valor) — lendo execucoes read-only
// (COCKPIT_SOURCES.runs). Estados cobertos:
//   - métrica configurada + dado            -> valor
//   - métrica configurada + carregando      -> shimmer (EC-16)
//   - métrica configurada + erro de leitura -> card de erro próprio (EC-15)
//   - escopo sem métrica                     -> "Sem dado configurado" (delta-16)
//   - nenhum card ativo                      -> empty honesto, grid intacto (EC-17)
// =====================================================================

import { useMemo, type ReactNode } from "react";
import {
  Boxes,
  Database,
  DownloadCloud,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { makeScopeConfig, scopeValueId } from "@/lib/engines/block-vis";
import { useBlocoConfig } from "@/hooks/use-configuracao";
import { useCockpitMetrics } from "@/hooks/use-cockpit-metrics";
import {
  discoverCockpitScopes,
  resolveMetric,
  type CockpitMetricDef,
  type CockpitScopeDef,
} from "@/lib/cockpit/sources";
import type { Execucao } from "@/lib/api/types";

/** Ícone por escopo de card. */
const SCOPE_ICONS: Record<string, ReactNode> = {
  ingestao: <Database aria-hidden="true" />,
  "ingestao.coleta": <DownloadCloud aria-hidden="true" />,
  "ingestao.erros": <TriangleAlert aria-hidden="true" />,
  cadastros: <Boxes aria-hidden="true" />,
  automacoes: <Zap aria-hidden="true" />,
};

function iconFor(escopo: string): ReactNode {
  return SCOPE_ICONS[escopo] ?? <Database aria-hidden="true" />;
}

function MetricCard({
  scope,
  metric,
  runs,
  isLoading,
  isError,
}: {
  scope: CockpitScopeDef;
  metric: CockpitMetricDef | null;
  runs: Execucao[];
  isLoading: boolean;
  isError: boolean;
}) {
  const icon = iconFor(scope.escopo);

  // EC-15: erro de leitura tem estado próprio, distinto do "Sem dado".
  if (metric && isError) {
    return (
      <article
        className="metric is-danger"
        role="alert"
        data-cockpit-card={scope.escopo}
      >
        <span>
          <TriangleAlert aria-hidden="true" />
          {metric.label}
        </span>
        <small className="metric-danger-copy">Falha ao ler execuções</small>
      </article>
    );
  }

  // EC-16: carregando mostra shimmer no corpo do card.
  if (metric && isLoading) {
    return (
      <article className="metric" aria-busy="true" data-cockpit-card={scope.escopo}>
        <span>
          {icon}
          {metric.label}
        </span>
        <span className="metric-shimmer" aria-hidden="true" />
      </article>
    );
  }

  // Métrica configurada com dado disponível.
  if (metric) {
    const v = metric.compute(runs);
    return (
      <article className="metric" data-cockpit-card={scope.escopo}>
        <span>
          {icon}
          {metric.label}
        </span>
        <strong>{v.display}</strong>
      </article>
    );
  }

  // Fallback honesto: escopo ativo sem métrica configurada (delta-16).
  return (
    <article className="metric" data-cockpit-card={scope.escopo}>
      <span>
        {icon}
        {scope.label}
      </span>
      <small className="metric-empty-mark">Sem dado configurado</small>
    </article>
  );
}

export function CockpitMetrics() {
  const { data } = useBlocoConfig(undefined, "card");
  const cfg = useMemo(() => makeScopeConfig("card", data ?? []), [data]);
  const scopes = useMemo(() => discoverCockpitScopes(cfg), [cfg]);
  const { runs, isLoading, isError } = useCockpitMetrics();

  // EC-17: nenhum card ativo -> empty honesto ocupando a faixa, sem quebrar grid.
  if (scopes.length === 0) {
    return (
      <section className="metrics" id="cockpitMetrics" aria-label="Sinais do cockpit">
        <p className="metrics-empty">
          <b>Sem dado configurado.</b> Ative cards em Configuração › Cards do
          cockpit.
        </p>
      </section>
    );
  }

  return (
    <section className="metrics" id="cockpitMetrics" aria-label="Sinais do cockpit">
      {scopes.map((scope) => (
        <MetricCard
          key={scope.escopo}
          scope={scope}
          metric={resolveMetric(scope.escopo, scopeValueId(cfg.valorOf(scope.escopo)))}
          runs={runs}
          isLoading={isLoading}
          isError={isError}
        />
      ))}
    </section>
  );
}
