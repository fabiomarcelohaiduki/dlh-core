import { CockpitMetrics } from "@/components/cockpit/cockpit-metrics";
import { DashboardGrid } from "@/components/cockpit/dashboard-grid";

/**
 * cockpit-view — view default do cockpit (rota /), SPEC 4.3.3 / 4.6.
 *
 * Casca server que compõe a faixa de métricas (`.metrics`) e a grade de painéis
 * (`.dashboard-grid`). A visibilidade/ordem de ambos é governada por
 * `bloco_config` (Configuração do cockpit) e resolvida em peças client
 * (`CockpitMetrics`, `DashboardGrid`). As métricas leem execucoes em modo
 * estritamente read-only (D-BE-04) — o cockpit nunca dispara coleta.
 */
export function CockpitView() {
  return (
    <section className="screen">
      <header className="dash-head">
        <div className="titles">
          <p className="eyebrow">Cockpit</p>
          <h2>Visão geral do cockpit</h2>
          <p className="lede">
            Estado geral das automações, ingestão de documentos e registros
            operacionais.
          </p>
        </div>
      </header>

      {/* Cards de métrica por escopo (renderCockpitCards). */}
      <CockpitMetrics />

      {/* Painéis fixos: mapa de sinais + coluna lateral (renderCockpitWidgets). */}
      <DashboardGrid />
    </section>
  );
}
