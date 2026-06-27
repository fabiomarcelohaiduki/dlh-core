"use client";

// =====================================================================
// RunsTable — tabela de Execuções da Coleta (subpane "Execuções"), read-only.
//
// Cada linha e uma rodada de coleta disparada (useExecucoes). A tabela honra
// a visibilidade resolvida dos blocos via useWorkbench():
//   - coluna de selecao (checkbox) so aparece quando o bloco `lote` esta visivel;
//   - coluna de acoes por linha so aparece quando `acoes-linha` esta visivel.
// Clicar numa linha abre o ActionModal (opcoes read-only). Estados EC-09/10/11
// vivem dentro do <tbody> para nao derrubar a view (table-states).
// =====================================================================

import { MoreHorizontal } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusPill } from "@/components/cockpit/status-pill";
import { execucaoDescriptor, normalizeOrigem, origemLabel } from "@/lib/status";
import type { Execucao } from "@/lib/api/types";
import { useWorkbench } from "./workbench-template";
import {
  WorkbenchSkeletonRows,
  WorkbenchTableEmpty,
  WorkbenchTableError,
  formatDateTime,
} from "./table-states";

export interface RunsTableProps {
  runs: Execucao[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** Abre o ActionModal para a execucao clicada (read-only). */
  onItemClick: (run: Execucao) => void;
  /** Selecao em lote (somente quando o bloco `lote` esta visivel). */
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], checked: boolean) => void;
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

export function RunsTable({
  runs,
  loading,
  error,
  onRetry,
  onItemClick,
  selectedIds,
  onToggle,
  onToggleAll,
  emptyTitle,
  emptyDescription,
}: RunsTableProps) {
  const { isVisible } = useWorkbench();
  const selectable = isVisible("lote");
  const showActions = isVisible("acoes-linha");

  // 10 colunas de dado + selecao + acoes (condicionais).
  const colSpan = 10 + (selectable ? 1 : 0) + (showActions ? 1 : 0);

  const allIds = runs.map((r) => r.id);
  const allChecked =
    selectable && allIds.length > 0 && allIds.every((id) => selectedIds.has(id));

  return (
    <Table aria-label="Execuções de coleta">
      <TableHeader>
        <TableRow>
          {selectable ? (
            <TableHead className="w-[1%]">
              <input
                type="checkbox"
                aria-label="Selecionar todas as execuções"
                checked={allChecked}
                disabled={loading || error || allIds.length === 0}
                onChange={(e) => onToggleAll(allIds, e.target.checked)}
              />
            </TableHead>
          ) : null}
          <TableHead>Início</TableHead>
          <TableHead>Origem</TableHead>
          <TableHead>Recurso</TableHead>
          <TableHead>Gatilho</TableHead>
          <TableHead>Janela</TableHead>
          <TableHead>Progresso</TableHead>
          <TableHead className="text-right">Novos</TableHead>
          <TableHead className="text-right">Alterados</TableHead>
          <TableHead>Duração</TableHead>
          <TableHead>Status</TableHead>
          {showActions ? (
            <TableHead data-block="acoes-linha" className="w-[1%] text-right">
              <span className="sr-only">Ações</span>
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
            const desc = execucaoDescriptor(run);
            const origem = origemLabel(normalizeOrigem(run.origem));
            const selected = selectedIds.has(run.id);
            return (
              <TableRow
                key={run.id}
                data-clickable=""
                data-selected={selected ? "true" : undefined}
                onClick={() => onItemClick(run)}
              >
                {selectable ? (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Selecionar execução de ${formatDateTime(run.inicio)}`}
                      checked={selected}
                      onChange={() => onToggle(run.id)}
                    />
                  </TableCell>
                ) : null}
                <TableCell className="whitespace-nowrap font-medium">
                  {formatDateTime(run.inicio)}
                </TableCell>
                <TableCell>{origem}</TableCell>
                <TableCell className="text-muted">{run.recurso ?? "—"}</TableCell>
                <TableCell className="text-muted">{run.gatilho || "—"}</TableCell>
                <TableCell className="text-muted">
                  {run.janelaDias != null ? `${run.janelaDias} dias` : "—"}
                </TableCell>
                <TableCell className="text-muted">{progressoText(run)}</TableCell>
                <TableCell className="text-right tabular-nums">{run.novos}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {run.alterados}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted">
                  {run.duracao ?? "—"}
                </TableCell>
                <TableCell>
                  <StatusPill state={desc.state} label={desc.label} />
                </TableCell>
                {showActions ? (
                  <TableCell
                    data-block="acoes-linha"
                    className="text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      aria-label={`Ações da execução de ${formatDateTime(run.inicio)}`}
                      onClick={() => onItemClick(run)}
                      className="grid size-7 place-items-center rounded-sm border border-border text-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
                    >
                      <MoreHorizontal aria-hidden="true" className="size-4" />
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
