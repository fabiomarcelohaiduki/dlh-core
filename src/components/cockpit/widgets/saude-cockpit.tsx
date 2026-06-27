"use client";

// =====================================================================
// saude-cockpit — painel fixo do cockpit (delta-17).
//
// Indicador agregado da saúde das execucoes (read-only). Score = % de execucoes
// concluídas sobre o total observado. Sem execucoes -> empty honesto (sem score
// inventado). O tom da pill e a barra de progresso seguem o score.
// =====================================================================

import { useMemo } from "react";
import { useCockpitMetrics } from "@/hooks/use-cockpit-metrics";
import { EmptyState } from "@/components/cockpit/ui/empty-state";
import type { PillState } from "@/lib/status";

function tomDoScore(score: number): { state: PillState; label: string } {
  if (score >= 80) return { state: "ok", label: "Estável" };
  if (score >= 50) return { state: "warn", label: "Atenção" };
  return { state: "err", label: "Crítico" };
}

export function SaudeCockpit() {
  const { runs } = useCockpitMetrics();

  const score = useMemo(() => {
    if (runs.length === 0) return null;
    const ok = runs.filter((r) => r.status === "concluida").length;
    return Math.round((ok / runs.length) * 100);
  }, [runs]);

  if (score === null) {
    return (
      <section
        className="card cockpit-widget"
        data-cockpit-widget="saude-cockpit"
        aria-label="Saúde do cockpit"
      >
        <div className="cockpit-widget-head">
          <div className="cockpit-widget-titles">
            <h3>Saúde do cockpit</h3>
            <p>Estado agregado das automações monitoradas.</p>
          </div>
          <span className="pill idle">
            <span className="dot" />
            Sem leitura
          </span>
        </div>
        <EmptyState hint="A saúde agregada é calculada quando há execuções registradas." />
      </section>
    );
  }

  const tom = tomDoScore(score);

  return (
    <article
      className="card cockpit-widget"
      data-cockpit-widget="saude-cockpit"
      aria-label="Saúde do cockpit"
    >
      <div className="cockpit-widget-titles">
        <h3>Saúde do cockpit</h3>
        <p>Estado agregado das automações monitoradas.</p>
      </div>
      <div className="score-row">
        <strong>{score}%</strong>
        <span className={`pill ${tom.state}`}>{tom.label}</span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Saúde agregada das execuções"
      >
        <span data-cockpit-bind="score" style={{ width: `${score}%` }} />
      </div>
    </article>
  );
}
