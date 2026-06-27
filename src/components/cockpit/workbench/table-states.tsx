"use client";

// =====================================================================
// table-states — estados compartilhados das tabelas do WorkbenchTemplate.
//
// Centraliza os 3 estados honestos exigidos pelas views de lista (EC-09/10/11),
// sempre renderizados DENTRO do <tbody> para preservar o "chrome" do workbench
// (cabecalho da tabela, bandas e barra de lote permanecem visiveis):
//   - WorkbenchSkeletonRows  EC-09: esqueleto de carregamento por linha;
//   - WorkbenchTableEmpty    EC-10: vazio honesto respeitando o filtro/guia;
//   - WorkbenchTableError    EC-11: erro de leitura com "Tentar novamente".
// =====================================================================

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";

/** EC-09 — linhas-esqueleto que mantem o numero de colunas e a altura. */
export function WorkbenchSkeletonRows({
  rows = 4,
  cols,
}: {
  rows?: number;
  cols: number;
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <TableRow key={r} aria-hidden="true">
          {Array.from({ length: cols }).map((__, c) => (
            <TableCell key={c}>
              <span className="block h-3.5 w-full max-w-[120px] animate-pulse rounded-sm bg-surface-2" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

/** EC-10 — vazio honesto, com titulo e orientacao contextual ao filtro/guia. */
export function WorkbenchTableEmpty({
  title,
  description,
  colSpan,
}: {
  title: string;
  description: string;
  colSpan: number;
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-12 text-center">
        <p className="text-[14px] font-semibold text-fg">{title}</p>
        <p className="mx-auto mt-1 max-w-[48ch] text-[13px] text-muted">
          {description}
        </p>
      </TableCell>
    </TableRow>
  );
}

/** EC-11 — erro de leitura preservando a view, com retentativa. */
export function WorkbenchTableError({
  title = "Não foi possível carregar",
  message = "Ocorreu uma falha ao buscar os dados. Tente novamente.",
  onRetry,
  colSpan,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  colSpan: number;
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-12 text-center">
        <span className="mx-auto grid size-9 place-items-center rounded-full bg-err-bg text-err">
          <TriangleAlert aria-hidden="true" className="size-[18px]" />
        </span>
        <p className="mt-2 text-[14px] font-semibold text-fg">{title}</p>
        <p className="mx-auto mt-1 max-w-[48ch] text-[13px] text-muted">
          {message}
        </p>
        {onRetry ? (
          <Button
            variant="default"
            size="sm"
            type="button"
            className="mx-auto mt-4"
            onClick={onRetry}
          >
            Tentar novamente
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/** Formata um ISO em data+hora curtas (pt-BR), tolerante a nulos. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
