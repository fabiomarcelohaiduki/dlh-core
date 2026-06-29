"use client";

// =====================================================================
// RunsTable — tabela de Execuções da Coleta (subpane "Execuções"), read-only.
//
// Cada linha e uma rodada de coleta disparada (useExecucoes). A tabela honra
// a visibilidade resolvida dos blocos via useWorkbench():
//   - coluna de acoes por linha so aparece quando `acoes-linha` esta visivel.
// Clicar numa linha abre o ActionModal (opcoes read-only). Estados EC-09/10/11
// vivem dentro do <tbody> para nao derrubar a view (table-states).
// =====================================================================

import { ScrollText } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusPill } from "@/components/cockpit/status-pill";
import {
  execucaoDescriptor,
  execucaoExecutor,
  normalizeOrigem,
  origemLabel,
  type OrigemKey,
} from "@/lib/status";
import type { Execucao } from "@/lib/api/types";
import type { AgendamentosColetaData } from "@/lib/fontes-credenciais-data";
import { useWorkbench } from "./workbench-template";
import type { TableColumn } from "./table-column";
import {
  WorkbenchSkeletonRows,
  WorkbenchTableEmpty,
  WorkbenchTableError,
  formatDateTime,
  splitDateTime,
} from "./table-states";

/** Execucao enriquecida com o horario agendado da sua fonte/recurso. */
export type RunComAgenda = Execucao & { horarioAgendado: string | null };

/**
 * Horario agendado (HH:MM, Brasilia) da fonte/recurso de uma execucao, lido do
 * agendamento da Coleta. Retorna null quando a fonte nao tem coleta automatica
 * ligada ou o recurso nao tem relogio proprio (ex.: Nomus fora de
 * processos/pessoas).
 */
export function horarioAgendadoDaFonte(
  origem: OrigemKey,
  recurso: string | null | undefined,
  ag: AgendamentosColetaData,
): string | null {
  const seAtivo = (a: { ativo: boolean; horarioReferencia: string | null }) =>
    a.ativo ? a.horarioReferencia : null;
  switch (origem) {
    case "effecti":
      return seAtivo(ag.effecti);
    case "gmail":
      return seAtivo(ag.gmail);
    case "drive":
      return seAtivo(ag.drive);
    case "nomus": {
      const r = (recurso ?? "").toLowerCase();
      if (r.includes("pessoa")) return seAtivo(ag.nomusPessoas);
      if (r.includes("process")) return seAtivo(ag.nomusProcessos);
      return null;
    }
    default:
      return null;
  }
}

/** "19:00" — horario agendado em HH:MM, ou "—" quando sem coleta automatica. */
function horaCurta(h: string | null): string {
  return h ? h.slice(0, 5) : "—";
}

/**
 * Periodo coberto pela coleta para a coluna Janela, honesto por fonte:
 *   - com janela_inicio/fim no checkpoint (Effecti, Nomus processos) -> "DD/MM – DD/MM";
 *   - so janelaDias (Effecti/Nomus legados sem periodo) -> "N dias";
 *   - Drive e Nomus pessoas (varrem tudo, sem janela) -> "completa";
 *   - sem nada -> "—".
 */
function janelaLabel(r: RunComAgenda): string {
  const origem = normalizeOrigem(r.origem);
  // Nomus carimba o modo EFETIVO no checkpoint (full = varredura completa;
  // incremental = so novos por id). A coluna JANELA prefixa o modo e, no full,
  // acrescenta o periodo coberto quando o recurso tem janela (processos).
  const modo = r.checkpoint?.modo;
  if (origem === "nomus" && modo) {
    if (modo === "incremental") return "Incremental";
    if (r.janelaInicio && r.janelaFim) {
      const ini = splitDateTime(r.janelaInicio).data;
      const fim = splitDateTime(r.janelaFim).data;
      return `Full · ${ini} – ${fim}`;
    }
    return "Full";
  }
  if (r.janelaInicio && r.janelaFim) {
    const ini = splitDateTime(r.janelaInicio).data;
    const fim = splitDateTime(r.janelaFim).data;
    return `${ini} – ${fim}`;
  }
  if (r.janelaDias != null) return `${r.janelaDias} dias`;
  if (origem === "drive" || origem === "nomus") return "completa";
  return "—";
}

export interface RunsTableProps {
  runs: RunComAgenda[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** Clique na linha: leva aos dados captados POR esta execucao (guia Dados). */
  onRowClick: (run: Execucao) => void;
  /** Botao de log da linha: abre a guia Logs filtrada pela fonte da execucao. */
  onLogClick: (run: Execucao) => void;
  /** Ids das colunas ocultas (controle da toolbar). */
  hidden?: ReadonlySet<string>;
  emptyTitle: string;
  emptyDescription: string;
}

/** Texto compacto de progresso da execucao (sem fabricar dado ausente). */
function progressoText(run: Execucao): string {
  if (run.status === "em_andamento" && run.totalProcessar != null) {
    const feitos = run.processadosSucesso ?? 0;
    return `${feitos}/${run.totalProcessar}`;
  }
  if (run.etapaAtual) return run.etapaAtual;
  return "—";
}

/**
 * Barra de progresso derivada SO de dado real (processadosSucesso/totalProcessar):
 *  - concluida -> trilho cheio (100%); em_andamento -> proporcao real;
 *  - erro -> proporcao real em vermelho; sem total conhecido -> trilho vazio.
 * O rotulo reaproveita progressoText (feitos/total, etapa ou "—"), nunca inventa pagina.
 */
function progressoMeta(run: Execucao): {
  pct: number;
  variant: "" | "is-run" | "is-fail";
  label: string;
} {
  const total = run.totalProcessar;
  const feitos = run.processadosSucesso ?? 0;
  const proporcao =
    total != null && total > 0 ? Math.min(100, Math.round((feitos / total) * 100)) : 0;
  if (run.status === "concluida") return { pct: 100, variant: "", label: progressoText(run) };
  if (run.status === "em_andamento")
    return { pct: proporcao, variant: "is-run", label: progressoText(run) };
  if (run.status === "erro")
    return { pct: proporcao, variant: "is-fail", label: progressoText(run) };
  return { pct: proporcao, variant: "", label: progressoText(run) };
}

/** Colunas de dado da tabela de Execuções (fonte unica p/ render + toolbar). */
export const RUNS_COLUMNS: readonly TableColumn<RunComAgenda>[] = [
  {
    id: "inicio",
    label: "Início",
    cellClass: "run-start",
    cell: (r) => {
      const { data, hora } = splitDateTime(r.inicio);
      return (
        <>
          <strong>{data}</strong>
          {hora ? <span>{hora}</span> : null}
        </>
      );
    },
    text: (r) => formatDateTime(r.inicio),
  },
  {
    id: "agendado",
    label: "Agendado",
    cellClass: "text-muted tabular-nums whitespace-nowrap",
    cell: (r) => horaCurta(r.horarioAgendado),
    text: (r) => (r.horarioAgendado ? r.horarioAgendado.slice(0, 5) : ""),
  },
  {
    id: "origem",
    label: "Origem",
    cell: (r) => (
      <span className="pill src">{origemLabel(normalizeOrigem(r.origem))}</span>
    ),
    text: (r) => origemLabel(normalizeOrigem(r.origem)),
  },
  {
    id: "executor",
    label: "Onde executa",
    cellClass: "text-muted",
    cell: (r) => execucaoExecutor(r.origem),
    text: (r) => execucaoExecutor(r.origem),
  },
  {
    id: "recurso",
    label: "Recurso",
    cellClass: "text-muted",
    cell: (r) => r.recurso ?? "—",
    text: (r) => r.recurso ?? "",
  },
  {
    id: "gatilho",
    label: "Gatilho",
    cellClass: "text-muted",
    cell: (r) => r.gatilho || "—",
    text: (r) => r.gatilho ?? "",
  },
  {
    id: "janela",
    label: "Janela",
    cellClass: "text-muted whitespace-nowrap",
    cell: (r) => janelaLabel(r),
    text: (r) => {
      const label = janelaLabel(r);
      return label === "—" ? "" : label;
    },
  },
  {
    id: "progresso",
    label: "Progresso",
    cell: (r) => {
      const { pct, variant, label } = progressoMeta(r);
      return (
        <div className={variant ? `run-progress ${variant}` : "run-progress"}>
          <div className="bar">
            <i style={{ width: `${pct}%` }} />
          </div>
          <span>{label}</span>
        </div>
      );
    },
    text: (r) => progressoText(r),
  },
  {
    id: "novos",
    label: "Novos",
    headClass: "text-right",
    cellClass: "text-right tabular-nums",
    cell: (r) =>
      r.novos > 0 ? (
        <span className="num-pos">+{r.novos}</span>
      ) : (
        <span className="num-zero">0</span>
      ),
    text: (r) => String(r.novos),
  },
  {
    id: "alterados",
    label: "Alterados",
    headClass: "text-right",
    cellClass: "text-right tabular-nums",
    cell: (r) =>
      r.alterados > 0 ? r.alterados : <span className="num-zero">0</span>,
    text: (r) => String(r.alterados),
  },
  {
    id: "duracao",
    label: "Duração",
    cellClass: "whitespace-nowrap text-muted",
    cell: (r) => r.duracao ?? "—",
    text: (r) => r.duracao ?? "",
  },
  {
    id: "status",
    label: "Status",
    cell: (r) => {
      const d = execucaoDescriptor(r);
      return <StatusPill state={d.state} label={d.label} />;
    },
    text: (r) => execucaoDescriptor(r).label,
  },
];

export function RunsTable({
  runs,
  loading,
  error,
  onRetry,
  onRowClick,
  onLogClick,
  hidden,
  emptyTitle,
  emptyDescription,
}: RunsTableProps) {
  const { isVisible } = useWorkbench();
  const showActions = isVisible("acoes-linha");

  const columns = RUNS_COLUMNS.filter((c) => !hidden?.has(c.id));
  const colSpan = columns.length + (showActions ? 1 : 0);

  return (
    <Table aria-label="Execuções de coleta">
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHead key={col.id} className={col.headClass}>
              {col.label}
            </TableHead>
          ))}
          {showActions ? (
            <TableHead data-block="acoes-linha" className="w-[1%] text-right">
              <span className="sr-only">Logs</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {error ? (
          <WorkbenchTableError
            title="Execuções indisponíveis"
            message="Não foi possível listar as execuções. Verifique a conexão e tente novamente."
            onRetry={onRetry}
            colSpan={colSpan}
          />
        ) : loading ? (
          <WorkbenchSkeletonRows cols={colSpan} />
        ) : runs.length === 0 ? (
          <WorkbenchTableEmpty
            title={emptyTitle}
            description={emptyDescription}
            colSpan={colSpan}
          />
        ) : (
          runs.map((run) => {
            return (
              <TableRow
                key={run.id}
                data-clickable=""
                onClick={() => onRowClick(run)}
              >
                {columns.map((col) => (
                  <TableCell key={col.id} className={col.cellClass}>
                    {col.cell(run)}
                  </TableCell>
                ))}
                {showActions ? (
                  <TableCell
                    data-block="acoes-linha"
                    className="text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      aria-label={`Ver logs da execução de ${formatDateTime(run.inicio)}`}
                      title="Ver logs desta execução"
                      onClick={() => onLogClick(run)}
                      className="grid size-7 place-items-center rounded-sm border border-border text-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
                    >
                      <ScrollText aria-hidden="true" className="size-4" />
                    </button>
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
