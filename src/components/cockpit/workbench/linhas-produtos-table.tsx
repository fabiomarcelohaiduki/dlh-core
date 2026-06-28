"use client";

// =====================================================================
// LinhasProdutosTable — tabela de Linhas de produtos (Cadastros), read-only.
//
// Mesmo padrao das demais tabelas do WorkbenchTemplate. Cada linha e uma
// familia que agrupa produtos do catalogo. Honra a visibilidade resolvida
// dos blocos via useWorkbench():
//   - coluna de selecao (checkbox) so aparece com o bloco `lote` visivel;
//   - coluna de acoes por linha so aparece com `acoes-linha` visivel.
// Clicar numa linha abre o ActionModal (opcoes read-only). Estados honestos
// EC-09/10/11 ficam dentro do <tbody> (table-states).
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
import type { PillState } from "@/lib/status";
import { useWorkbench } from "./workbench-template";
import type { TableColumn } from "./table-column";
import {
  WorkbenchSkeletonRows,
  WorkbenchTableEmpty,
  WorkbenchTableError,
} from "./table-states";

/** Linha de produtos (familia) — linha read-only da tabela. */
export interface LinhaProdutoRow {
  id: string;
  codigo: string;
  descricao: string;
  /** Quantidade de produtos associados a esta linha. */
  produtosAssociados: number;
  estado: { state: PillState; label: string };
}

/** Colunas de dado da tabela de Linhas (fonte unica p/ render + toolbar). */
export const LINHAS_COLUMNS: readonly TableColumn<LinhaProdutoRow>[] = [
  {
    id: "codigo",
    label: "Código",
    cellClass: "whitespace-nowrap font-medium tabular-nums",
    cell: (l) => l.codigo,
    text: (l) => l.codigo,
  },
  {
    id: "descricao",
    label: "Descrição",
    cell: (l) => l.descricao,
    text: (l) => l.descricao,
  },
  {
    id: "produtosAssociados",
    label: "Produtos associados",
    headClass: "text-right",
    cellClass: "text-right tabular-nums",
    cell: (l) =>
      l.produtosAssociados > 0 ? (
        l.produtosAssociados
      ) : (
        <span className="num-zero">0</span>
      ),
    text: (l) => String(l.produtosAssociados),
  },
  {
    id: "estado",
    label: "Estado",
    cell: (l) => <StatusPill state={l.estado.state} label={l.estado.label} />,
    text: (l) => l.estado.label,
  },
];

export interface LinhasProdutosTableProps {
  linhas: LinhaProdutoRow[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** Abre o ActionModal para a linha clicada (read-only). */
  onItemClick: (linha: LinhaProdutoRow) => void;
  /** Selecao em lote (somente quando o bloco `lote` esta visivel). */
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], checked: boolean) => void;
  /** Ids das colunas ocultas (controle da toolbar). */
  hidden?: ReadonlySet<string>;
  emptyTitle: string;
  emptyDescription: string;
}

export function LinhasProdutosTable({
  linhas,
  loading,
  error,
  onRetry,
  onItemClick,
  selectedIds,
  onToggle,
  onToggleAll,
  hidden,
  emptyTitle,
  emptyDescription,
}: LinhasProdutosTableProps) {
  const { isVisible } = useWorkbench();
  const selectable = isVisible("lote");
  const showActions = isVisible("acoes-linha");

  const columns = LINHAS_COLUMNS.filter((c) => !hidden?.has(c.id));
  const colSpan = columns.length + (selectable ? 1 : 0) + (showActions ? 1 : 0);

  const allIds = linhas.map((l) => l.id);
  const allChecked =
    selectable && allIds.length > 0 && allIds.every((id) => selectedIds.has(id));

  return (
    <Table aria-label="Linhas de produtos">
      <TableHeader>
        <TableRow>
          {selectable ? (
            <TableHead className="w-[1%]">
              <input
                type="checkbox"
                aria-label="Selecionar todas as linhas de produtos"
                checked={allChecked}
                disabled={loading || error || allIds.length === 0}
                onChange={(e) => onToggleAll(allIds, e.target.checked)}
              />
            </TableHead>
          ) : null}
          {columns.map((col) => (
            <TableHead key={col.id} className={col.headClass}>
              {col.label}
            </TableHead>
          ))}
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
            title="Linhas indisponíveis"
            message="Não foi possível listar as linhas de produtos. Verifique a conexão e tente novamente."
            onRetry={onRetry}
            colSpan={colSpan}
          />
        ) : loading ? (
          <WorkbenchSkeletonRows cols={colSpan} />
        ) : linhas.length === 0 ? (
          <WorkbenchTableEmpty
            title={emptyTitle}
            description={emptyDescription}
            colSpan={colSpan}
          />
        ) : (
          linhas.map((linha) => {
            const selected = selectedIds.has(linha.id);
            return (
              <TableRow
                key={linha.id}
                data-clickable=""
                data-selected={selected ? "true" : undefined}
                onClick={() => onItemClick(linha)}
              >
                {selectable ? (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Selecionar linha ${linha.codigo}`}
                      checked={selected}
                      onChange={() => onToggle(linha.id)}
                    />
                  </TableCell>
                ) : null}
                {columns.map((col) => (
                  <TableCell key={col.id} className={col.cellClass}>
                    {col.cell(linha)}
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
                      aria-label={`Ações da linha ${linha.codigo}`}
                      onClick={() => onItemClick(linha)}
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
