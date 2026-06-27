"use client";

// =====================================================================
// ProdutosTable — tabela de Produtos do modulo Cadastros, read-only.
//
// Instancia o mesmo padrao das tabelas do WorkbenchTemplate (RunsTable/
// DadosTable). Cada linha e um produto do catalogo. A tabela honra a
// visibilidade resolvida dos blocos via useWorkbench():
//   - coluna de selecao (checkbox) so aparece quando o bloco `lote` esta visivel;
//   - coluna de acoes por linha so aparece quando `acoes-linha` esta visivel.
// Clicar numa linha abre o ActionModal (opcoes read-only). Os estados honestos
// EC-09/10/11 vivem dentro do <tbody> (table-states), preservando o chrome.
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

/** Produto do catalogo (linha read-only da tabela de Produtos). */
export interface ProdutoRow {
  id: string;
  codigo: string;
  descricao: string;
  /** Linha de produtos a que o item pertence (origem do catalogo). */
  origem: string;
  estado: { state: PillState; label: string };
}

export interface ProdutosTableProps {
  produtos: ProdutoRow[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** Abre o ActionModal para o produto clicado (read-only). */
  onItemClick: (produto: ProdutoRow) => void;
  /** Selecao em lote (somente quando o bloco `lote` esta visivel). */
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], checked: boolean) => void;
  emptyTitle: string;
  emptyDescription: string;
}

export function ProdutosTable({
  produtos,
  loading,
  error,
  onRetry,
  onItemClick,
  selectedIds,
  onToggle,
  onToggleAll,
  emptyTitle,
  emptyDescription,
}: ProdutosTableProps) {
  const { isVisible } = useWorkbench();
  const selectable = isVisible("lote");
  const showActions = isVisible("acoes-linha");

  // 4 colunas de dado + selecao + acoes (condicionais).
  const colSpan = 4 + (selectable ? 1 : 0) + (showActions ? 1 : 0);

  const allIds = produtos.map((p) => p.id);
  const allChecked =
    selectable && allIds.length > 0 && allIds.every((id) => selectedIds.has(id));

  return (
    <Table aria-label="Catálogo de produtos">
      <TableHeader>
        <TableRow>
          {selectable ? (
            <TableHead className="w-[1%]">
              <input
                type="checkbox"
                aria-label="Selecionar todos os produtos"
                checked={allChecked}
                disabled={loading || error || allIds.length === 0}
                onChange={(e) => onToggleAll(allIds, e.target.checked)}
              />
            </TableHead>
          ) : null}
          <TableHead>Código</TableHead>
          <TableHead>Descrição</TableHead>
          <TableHead>Origem</TableHead>
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
            title="Produtos indisponíveis"
            message="Não foi possível listar o catálogo de produtos. Verifique a conexão e tente novamente."
            onRetry={onRetry}
            colSpan={colSpan}
          />
        ) : loading ? (
          <WorkbenchSkeletonRows cols={colSpan} />
        ) : produtos.length === 0 ? (
          <WorkbenchTableEmpty
            title={emptyTitle}
            description={emptyDescription}
            colSpan={colSpan}
          />
        ) : (
          produtos.map((produto) => {
            const selected = selectedIds.has(produto.id);
            return (
              <TableRow
                key={produto.id}
                data-clickable=""
                data-selected={selected ? "true" : undefined}
                onClick={() => onItemClick(produto)}
              >
                {selectable ? (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Selecionar produto ${produto.codigo}`}
                      checked={selected}
                      onChange={() => onToggle(produto.id)}
                    />
                  </TableCell>
                ) : null}
                <TableCell className="whitespace-nowrap font-medium tabular-nums">
                  {produto.codigo}
                </TableCell>
                <TableCell>{produto.descricao}</TableCell>
                <TableCell className="text-muted">{produto.origem}</TableCell>
                <TableCell>
                  <StatusPill
                    state={produto.estado.state}
                    label={produto.estado.label}
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
                      aria-label={`Ações do produto ${produto.codigo}`}
                      onClick={() => onItemClick(produto)}
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
