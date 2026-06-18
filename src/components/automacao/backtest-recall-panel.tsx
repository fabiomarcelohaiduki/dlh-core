import { CheckCircle2, ShieldCheck, Target, Trash2, Server } from "lucide-react";
import type { BacktestRecall } from "@/lib/api/types";
import { formatNumber } from "@/lib/format";
import { StatCard } from "@/components/cockpit/stat-card";

/** Recall (fracao 0..1) -> percentual inteiro; nulo -> "—" (Nomus indisponivel). */
function formatRecall(recall: number | null): string {
  return recall != null ? `${Math.round(recall * 100)}%` : "—";
}

/**
 * cmp-backtest-recall-panel — Painel de cards do backtest de recall (modo
 * sombra). Materializa o gate visual antes de ligar o descarte fisico: recall
 * da triagem, processos reais lidos do Nomus, quantos casaram com aviso, quantos
 * a triagem preservaria e quantos descartaria indevidamente. Reaproveita o
 * StatCard do Dashboard (skeleton no fetch, sem layout shift). Somente leitura.
 *
 *   recall = preservadosPelaTriagem / casadosComAviso
 */
export function BacktestRecallPanel({
  data,
  loading = false,
}: {
  data?: BacktestRecall;
  loading?: boolean;
}) {
  const recall = data?.recall ?? null;
  const casados = data?.casadosComAviso ?? 0;
  const descartados = data?.descartadosIndevidamente ?? 0;

  // Recall nulo (Nomus indisponivel) nao colore; senao verde >= 90%, ambar abaixo.
  const recallTone: "up" | "warn" | "default" =
    recall == null ? "default" : recall >= 0.9 ? "up" : "warn";

  return (
    <div className="grid-dlh g5 stat-rise">
      <StatCard
        index={0}
        icon={<Target aria-hidden="true" />}
        label="Recall"
        loading={loading}
        value={<span className="tnum">{formatRecall(recall)}</span>}
        meta={
          recall == null
            ? "Indisponível neste período"
            : "Preservados ÷ casados com aviso"
        }
        metaTone={recallTone}
      />
      <StatCard
        index={1}
        icon={<Server aria-hidden="true" />}
        label="Processos Nomus reais"
        loading={loading}
        value={formatNumber(data?.processosNomusReais)}
        meta="Lidos do Nomus no período"
      />
      <StatCard
        index={2}
        icon={<CheckCircle2 aria-hidden="true" />}
        label="Casados com aviso"
        loading={loading}
        value={formatNumber(casados)}
        meta="Verdade-fundamental do recall"
      />
      <StatCard
        index={3}
        icon={<ShieldCheck aria-hidden="true" />}
        label="Preservados pela triagem"
        loading={loading}
        value={formatNumber(data?.preservadosPelaTriagem)}
        meta="Veredito útil ou dúvida"
        metaTone="up"
      />
      <StatCard
        index={4}
        icon={<Trash2 aria-hidden="true" />}
        label="Descartados indevidamente"
        loading={loading}
        value={
          <span
            className="tnum"
            style={{ color: descartados > 0 ? "var(--err)" : undefined }}
          >
            {formatNumber(descartados)}
          </span>
        }
        meta={
          descartados > 0
            ? "Falso-descarte (recall miss)"
            : "Nenhum falso-descarte"
        }
        metaTone={descartados > 0 ? "warn" : "up"}
      />
    </div>
  );
}
