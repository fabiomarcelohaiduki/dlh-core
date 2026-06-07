import type { ReactNode } from "react";
import { Activity, Loader2, RotateCcw } from "lucide-react";
import type { Execucao } from "@/lib/api/types";
import { execucaoDescriptor, precisaRetomadaManual } from "@/lib/status";
import {
  formatDateTime,
  formatDuracao,
  formatGatilho,
  formatJanela,
  formatRecurso,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/cockpit/status-pill";
import { OrigemBadge } from "@/components/cockpit/origem-badge";

type Variant = "dashboard" | "execucoes";

const COLUMNS: Record<Variant, string[]> = {
  dashboard: ["Início", "Gatilho", "Novos", "Alterados", "Duração", "Status"],
  execucoes: [
    "Execução",
    "Início",
    "Origem",
    "Recurso",
    "Gatilho",
    "Janela",
    "Progresso",
    "Novos",
    "Alterados",
    "Duração",
    "Status",
  ],
};

/** Celula de contagem: positivos em verde (+N), zero esmaecido. */
function NumCell({ value }: { value: number }) {
  return value > 0 ? (
    <span className="num-pos tnum">+{value}</span>
  ) : (
    <span className="num-zero tnum">0</span>
  );
}

/**
 * Progresso ao vivo (US-15): barra processados_sucesso/total_processar e o
 * cursor checkpoint.pagina_atual para fontes em blocos (Nomus). Sem dados de
 * bloco (Effecti monolitico parado) cai em "—". Em andamento sem total
 * conhecido usa barra indeterminada.
 */
function ProgressCell({ execucao }: { execucao: Execucao }) {
  const total = execucao.totalProcessar ?? 0;
  const sucesso = execucao.processadosSucesso ?? 0;
  const erro = execucao.processadosErro ?? 0;
  const pagina = execucao.checkpoint?.paginaAtual ?? null;
  const running = execucao.status === "em_andamento";

  if (total === 0 && pagina == null && !running) {
    return <span className="sub">—</span>;
  }

  const pct = total > 0 ? Math.min(100, Math.round((sucesso / total) * 100)) : null;
  const indeterminate = pct == null && running;

  const parts: string[] = [];
  if (pagina != null) parts.push(`pág ${pagina}`);
  if (total > 0) parts.push(`${sucesso}/${total}`);
  else if (pagina == null) parts.push(String(sucesso));
  if (erro > 0) parts.push(`${erro} erro${erro > 1 ? "s" : ""}`);

  return (
    <div className="cell-stack">
      <span
        className="prog"
        role="progressbar"
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          className="prog-bar"
          data-indet={indeterminate || undefined}
          style={pct != null ? { width: `${pct}%` } : undefined}
        />
      </span>
      <span className="sub tnum">{parts.join(" · ") || "—"}</span>
    </div>
  );
}

function StatusCell({
  execucao,
  onRetomar,
  retomando,
}: {
  execucao: Execucao;
  onRetomar?: (execucao: Execucao) => void;
  retomando?: boolean;
}) {
  const desc = execucaoDescriptor(execucao);
  const processing = execucao.status === "em_andamento";
  // Acao manual: execucao em erro que esgotou as retomadas automaticas (Nomus).
  const manualResume = Boolean(onRetomar) && precisaRetomadaManual(execucao);

  return (
    <div className="cell-stack">
      <StatusPill state={desc.state} label={desc.label} />
      {processing && execucao.etapaAtual ? (
        <span className="sub">etapa: {execucao.etapaAtual}</span>
      ) : null}
      {manualResume ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            onRetomar?.(execucao);
          }}
          disabled={retomando}
        >
          {retomando ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <RotateCcw aria-hidden="true" />
          )}
          Retomar
        </button>
      ) : null}
    </div>
  );
}

function SkeletonRows({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c}>
              <span
                className="skel skel-line"
                style={{ width: c === cols - 1 ? 104 : `${50 + ((r + c) % 4) * 12}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * cmp-runs-table — Tabela de execucoes (Dashboard e Execucoes).
 *
 * Estados travados:
 *  - loading: skeleton rows (sem layout shift)
 *  - empty: estado vazio composto com onboarding
 *  - processing: linhas em_andamento exibem o pill `run` (dot pulsante), a
 *    etapa atual e o progresso ao vivo (origem-aware: processados/total +
 *    checkpoint.pagina_atual).
 *
 * Na variante `execucoes` ganha colunas origem/recurso e a barra de progresso;
 * execucoes em erro que esgotaram a retomada automatica (Nomus) expoem a acao
 * manual `Retomar`. Linhas com status `erro` ficam clicaveis (navegacao para
 * /erros) quando `onErroClick` e informado.
 */
export function RunsTable({
  runs,
  variant = "dashboard",
  loading = false,
  emptyTitle,
  emptyDescription,
  emptyAction,
  onErroClick,
  onRetomar,
  retomandoId,
  footer,
}: {
  runs: Execucao[];
  variant?: Variant;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  onErroClick?: (execucao: Execucao) => void;
  onRetomar?: (execucao: Execucao) => void;
  retomandoId?: string | null;
  footer?: ReactNode;
}) {
  const columns = COLUMNS[variant];
  const colCount = columns.length;
  const isExecucoes = variant === "execucoes";

  return (
    <div className="tbl-wrap tbl-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows cols={colCount} />
          ) : runs.length === 0 ? (
            <tr>
              <td colSpan={colCount}>
                <div className="empty">
                  <Activity aria-hidden="true" />
                  <h4>{emptyTitle ?? "Nenhuma execução"}</h4>
                  <p>
                    {emptyDescription ??
                      "Quando uma coleta — agendada ou sob demanda — for executada, ela aparece aqui."}
                  </p>
                  {emptyAction ? <div style={{ marginTop: 16 }}>{emptyAction}</div> : null}
                </div>
              </td>
            </tr>
          ) : (
            runs.map((r) => {
              const isErro = r.status === "erro";
              const clickable = isErro && Boolean(onErroClick);
              return (
                <tr
                  key={r.id}
                  className={cn(clickable && "clk")}
                  onClick={clickable ? () => onErroClick?.(r) : undefined}
                >
                  {isExecucoes && <td className="mono">{r.id}</td>}
                  <td className="tnum">{formatDateTime(r.inicio)}</td>
                  {isExecucoes && (
                    <td>
                      <OrigemBadge origem={r.origem} />
                    </td>
                  )}
                  {isExecucoes && <td className="sub">{formatRecurso(r.recurso)}</td>}
                  <td>{formatGatilho(r.gatilho)}</td>
                  {isExecucoes && <td className="sub">{formatJanela(r.janelaDias)}</td>}
                  {isExecucoes && (
                    <td>
                      <ProgressCell execucao={r} />
                    </td>
                  )}
                  <td>
                    <NumCell value={r.novos} />
                  </td>
                  <td className="tnum">{r.alterados}</td>
                  <td className="tnum sub">{formatDuracao(r.duracao)}</td>
                  <td>
                    <StatusCell
                      execucao={r}
                      onRetomar={isExecucoes ? onRetomar : undefined}
                      retomando={retomandoId === r.id}
                    />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      {footer}
    </div>
  );
}
