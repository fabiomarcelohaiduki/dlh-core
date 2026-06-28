import type { ReactNode } from "react";

// =====================================================================
// TableColumn — descritor de coluna das tabelas do workbench.
//
// Centraliza rotulo, render da celula e (opcionalmente) o texto usado pelo
// filtro por campo. As tabelas (RunsTable/DadosTable) renderizam cabecalho e
// celulas a partir desta lista, e a toolbar usa os mesmos descritores para
// montar os menus de "mostrar/ocultar coluna" e "filtrar campo".
// =====================================================================

export interface TableColumn<T> {
  /** Identificador estavel da coluna (usado em visibilidade e filtro). */
  id: string;
  /** Rotulo exibido no cabecalho e nos menus da toolbar. */
  label: string;
  /** Classe extra do cabecalho (ex.: "text-right"). */
  headClass?: string;
  /** Classe extra da celula (ex.: "text-muted tabular-nums"). */
  cellClass?: string;
  /** Conteudo renderizado da celula. */
  cell: (row: T) => ReactNode;
  /** Texto plano para o filtro por campo. Ausente = coluna nao filtravel. */
  text?: (row: T) => string;
}

/** Metadado leve da coluna (id + rotulo) para os menus da toolbar. */
export interface TableColumnMeta {
  id: string;
  label: string;
}

/** Projeta os descritores em metadados leves (id + rotulo). */
export function columnMeta<T>(columns: readonly TableColumn<T>[]): TableColumnMeta[] {
  return columns.map((c) => ({ id: c.id, label: c.label }));
}

/** Metadados das colunas filtraveis (que expoem `text`). */
export function filterableMeta<T>(
  columns: readonly TableColumn<T>[],
): TableColumnMeta[] {
  return columns.filter((c) => c.text).map((c) => ({ id: c.id, label: c.label }));
}

/** Verdadeiro se a linha satisfaz todos os filtros por campo ativos (AND). */
export function matchFieldFilters<T>(
  row: T,
  columns: readonly TableColumn<T>[],
  filters: Record<string, string>,
): boolean {
  for (const col of columns) {
    const raw = filters[col.id];
    if (!raw || !raw.trim() || !col.text) continue;
    if (!col.text(row).toLowerCase().includes(raw.trim().toLowerCase())) {
      return false;
    }
  }
  return true;
}
