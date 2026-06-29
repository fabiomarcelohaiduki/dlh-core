"use client";

// =====================================================================
// table-pagination — paginacao client-side compartilhada das tabelas do
// WorkbenchTemplate (25 itens por pagina por padrao).
//
//   - usePagination(items, pageSize): fatia a lista ja filtrada na pagina
//     corrente e mantem a pagina valida quando a lista encolhe (filtro/busca);
//   - TablePager: rodape com "Mostrando X–Y de Z" + navegacao anterior/proxima.
//
// Reusada por todas as views de tabela para manter o rodape identico entre
// elas, no mesmo idioma visual da toolbar (altura 42px, raio 12px).
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Quantidade padrao de itens por pagina nas tabelas do cockpit. */
export const DEFAULT_PAGE_SIZE = 25;

export interface Pagination<T> {
  /** Itens da pagina corrente (fatia da lista filtrada). */
  pageItems: T[];
  /** Pagina atual (base 1). */
  page: number;
  setPage: (page: number) => void;
  /** Total de paginas (>= 1). */
  totalPages: number;
  /** Total de itens na lista filtrada. */
  total: number;
  pageSize: number;
}

/**
 * Pagina uma lista ja filtrada. Mantem a pagina dentro do intervalo valido
 * quando o total muda (ex.: ao aplicar um filtro que reduz a lista). Passe um
 * `resetKey` (ex.: assinatura dos filtros ativos) para voltar a pagina 1 sempre
 * que o criterio mudar, evitando ficar numa pagina antiga apos trocar o filtro.
 */
export function usePagination<T>(
  items: T[],
  pageSize: number = DEFAULT_PAGE_SIZE,
  resetKey?: string,
): Pagination<T> {
  const [page, setPage] = useState(1);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => items.slice((safePage - 1) * pageSize, safePage * pageSize),
    [items, safePage, pageSize],
  );

  return { pageItems, page: safePage, setPage, totalPages, total, pageSize };
}

// =====================================================================
// CursorPager — variante por keyset/cursor server-side (guia "Dados").
//
// Diferente do TablePager (paginacao client-side sobre uma lista ja carregada
// inteira), aqui o backend devolve uma pagina por vez com um `nextCursor`
// opaco: nao conhecemos o total de paginas. O estado do cursor (pilha de
// cursores) vive no client da view; este componente so reflete os flags e
// dispara os callbacks de navegacao. Quando nao ha proxima pagina, desabilita
// "Proxima" e exibe um rodape neutro ("Fim dos resultados") sem chamada extra.
// Mantem o mesmo idioma visual do TablePager (altura/raio/cores via tokens).
// =====================================================================

export interface CursorPaginationProps {
  /** Pagina corrente (base 1), apenas para exibicao. */
  page: number;
  /** Ha pagina anterior na pilha de cursores. */
  hasPrev: boolean;
  /** Ha proxima pagina (nextCursor !== null). */
  hasNext: boolean;
  /** Volta para a pagina anterior (desempilha o cursor). */
  onPrev: () => void;
  /** Avanca para a proxima pagina (empilha o nextCursor). */
  onNext: () => void;
  /** Trava a navegacao enquanto a pagina esta sendo buscada. */
  isFetching?: boolean;
  /**
   * Total de registros no conjunto filtrado, quando conhecido. Omitido (ex.:
   * busca textual ativa) cai no rodape neutro "Página X" sem inventar total.
   */
  total?: number;
  /**
   * Total de paginas derivado do `total`. Quando presente, o rodape espelha a
   * guia Execuções ("X de Y"); quando ausente, exibe so a pagina corrente.
   */
  totalPages?: number;
}

/** Rodape de paginacao por cursor server-side (sempre visivel). */
export function CursorPager({
  page,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  isFetching = false,
  total,
  totalPages,
}: CursorPaginationProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-[18px] py-3">
      <span className="text-[12.5px] text-muted">
        {total !== undefined
          ? `${total} ${total === 1 ? "registro" : "registros"}`
          : hasNext
            ? `Página ${page}`
            : "Fim dos resultados"}
      </span>
      <div className="flex items-center gap-2.5">
        <Button
          variant="default"
          size="sm"
          type="button"
          aria-label="Página anterior"
          disabled={!hasPrev || isFetching}
          onClick={onPrev}
        >
          <ChevronLeft aria-hidden="true" />
          Anterior
        </Button>
        <span className="text-[12.5px] tabular-nums text-muted">
          {totalPages !== undefined ? `${page} de ${totalPages}` : page}
        </span>
        <Button
          variant="default"
          size="sm"
          type="button"
          aria-label="Próxima página"
          disabled={!hasNext || isFetching}
          onClick={onNext}
        >
          Próxima
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/** Rodape de paginacao da tabela. Some quando ha uma unica pagina. */
export function TablePager<T>({ page, setPage, totalPages, total, pageSize }: Pagination<T>) {
  if (totalPages <= 1) return null;

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-[18px] py-3">
      <span className="text-[12.5px] text-muted">
        Mostrando {from}–{to} de {total}
      </span>
      <div className="flex items-center gap-2.5">
        <Button
          variant="default"
          size="sm"
          type="button"
          aria-label="Página anterior"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft aria-hidden="true" />
          Anterior
        </Button>
        <span className="text-[12.5px] tabular-nums text-muted">
          {page} de {totalPages}
        </span>
        <Button
          variant="default"
          size="sm"
          type="button"
          aria-label="Próxima página"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          Próxima
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
