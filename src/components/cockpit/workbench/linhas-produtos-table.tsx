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
  emptyTitle,
  emptyDescription,
}: LinhasProdutosTableProps) {
  const { isVisible } = useWorkbench();
  const selectable = isVisible("lote");
  const showActions = isVisible("acoes-linha");

  // 4 colunas de dado + selecao + acoes (condicionais).
  const colSpan = 4 + (selectable ? 1 : 0) + (showActions ? 1 : 0);

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
          <TableHead>Código</TableHead>
          <TableHead>Descrição</TableHead>
          <TableHead className="text-right">Produtos associados</TableHead>
          <TableHead>Estado</TableHead>
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
                <TableCell className="whitespace-nowrap font-medium tabular-nums">
                  {linha.codigo}
                </TableCell>
                <TableCell>{linha.descricao}</TableCell>
                <TableCell className="text-right tabular-nums text-muted">
                  {linha.produtosAssociados}
                </TableCell>
                <TableCell>
                  <StatusPill
                    state={linha.estado.state}
                    label={linha.estado.label}
                  />
                </TableCell>
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
