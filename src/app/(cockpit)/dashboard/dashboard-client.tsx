"use client";

import { useHealthcheck } from "@/hooks/use-monitoring";
import { healthDescriptor, healthMeta, type PillState } from "@/lib/status";
import { formatNumber } from "@/lib/format";
import { MapaSinais } from "@/components/cockpit/widgets/mapa-sinais";
import { SaudeCockpit } from "@/components/cockpit/widgets/saude-cockpit";
import { AtalhosOperacionais } from "@/components/cockpit/widgets/atalhos-operacionais";

type Severity = "ok" | "warn" | "danger" | "neutral";

/** Estado do pill de saude -> severidade do dot do card de metrica. */
function severidade(state: PillState): Severity {
  if (state === "ok") return "ok";
  if (state === "warn" || state === "run") return "warn";
  return "danger";
}

/**
 * DashboardClient — visao geral do cockpit (rota /dashboard), espelhando o
 * Design Lock: faixa de tres metricas (.metrics) + grade de paineis fixos
 * (.dashboard-grid: mapa de sinais a esquerda; saude e atalhos na lateral).
 * Leitura estritamente read-only — o cockpit nunca dispara coleta.
 */
export function DashboardClient() {
  // Poll leve: mantem os numeros frescos sem recarregar a pagina.
  const health = useHealthcheck({ refetchInterval: 30_000 });
  const d = health.data;
  const loading = health.isLoading;

  const totalAvisos = d?.totalAvisos ?? 0;
  const totalProcessos = d?.totalProcessos ?? 0;
  const totalPessoas = d?.totalPessoas ?? 0;
  const totalSubstrato = totalAvisos + totalProcessos + totalPessoas;
  const itensComErro = d?.itensComErro ?? 0;

  const statusIngestao = d?.statusIngestao ?? "Falha";
  const statusPill = healthDescriptor(statusIngestao);
  const statusInfo = healthMeta(statusIngestao);

  const valor = (v: string) => (loading ? "…" : v);

  return (
    <section className="screen">
      <section className="metrics" aria-label="Sinais do cockpit">
        <article className="metric" data-severity="neutral">
          <span>Substrato</span>
          <strong>{valor(formatNumber(totalSubstrato))}</strong>
          <small>
            {formatNumber(totalAvisos)} avisos · {formatNumber(totalProcessos)} processos ·{" "}
            {formatNumber(totalPessoas)} pessoas
          </small>
        </article>

        <article
          className="metric"
          data-severity={loading ? "neutral" : severidade(statusPill.state)}
        >
          <span>Status da ingestão</span>
          <strong>{valor(statusPill.label)}</strong>
          <small>{statusInfo.text}</small>
        </article>

        <article
          className="metric"
          data-severity={loading ? "neutral" : itensComErro > 0 ? "danger" : "ok"}
        >
          <span>Itens com erro</span>
          <strong>{valor(formatNumber(itensComErro))}</strong>
          <small>
            {itensComErro > 0
              ? "Verifique a lista de erros de ingestão"
              : "Pipeline sem itens em erro"}
          </small>
        </article>
      </section>

      <div className="dashboard-grid">
        <MapaSinais />
        <aside className="side-stack">
          <SaudeCockpit />
          <AtalhosOperacionais />
        </aside>
      </div>
    </section>
  );
}
