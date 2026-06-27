"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Table composta do design system (D-FE-04).
 *
 * Espelha a tabela densa do artifact (`.table-scroll`, th/td com tokens
 * surface/border/fg/muted). A densidade segue o idioma do Design Lock:
 * `body.compact` / `body.comfortable` aplicam padding 9px / 16px nos th,td;
 * o nivel "padrao" mantem o padding base (14px). A densidade padrao e
 * `comfortable`.
 *
 * Sem hex hardcoded: cores e radii resolvem via tokens CSS expostos pelo
 * Tailwind. Em telas estreitas o wrapper rola horizontalmente (overflow-x)
 * sem quebrar o layout.
 */
export type Density = "compact" | "padrao" | "comfortable";

interface TableDensityContextValue {
  density: Density;
  setDensity: (level: Density) => void;
}

const TableDensityContext =
  React.createContext<TableDensityContextValue | null>(null);

/**
 * Hook para ler/alternar a densidade de uma Table a partir de qualquer
 * descendente (ex.: um controle Segmented vivendo no cabecalho do card).
 */
export function useTableDensity(): TableDensityContextValue {
  const ctx = React.useContext(TableDensityContext);
  if (!ctx) {
    throw new Error("useTableDensity deve ser usado dentro de <Table>.");
  }
  return ctx;
}

/**
 * Mapa densidade -> classes de padding vertical em th/td via variantes
 * descendentes do Tailwind. So o eixo vertical muda; o padding horizontal
 * (px) permanece o do estilo base, preservando o alinhamento das colunas.
 */
const densityClass: Record<Density, string> = {
  compact: "[&_th]:!py-[9px] [&_td]:!py-[9px]",
  padrao: "",
  comfortable: "[&_th]:!py-4 [&_td]:!py-4",
};

export interface TableProps
  extends Omit<React.HTMLAttributes<HTMLTableElement>, "onChange"> {
  /** Densidade controlada. Quando ausente, o componente gerencia internamente. */
  density?: Density;
  /** Densidade inicial no modo nao-controlado. Padrao: comfortable. */
  defaultDensity?: Density;
  /** Notifica mudancas de densidade (controlado ou nao-controlado). */
  onDensityChange?: (level: Density) => void;
  /** Classe aplicada ao wrapper de rolagem (`.table-scroll`). */
  wrapperClassName?: string;
  /** Habilita cabecalho fixo + altura limitada (idioma `tbl-enh`). */
  sticky?: boolean;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  (
    {
      density: densityProp,
      defaultDensity = "comfortable",
      onDensityChange,
      wrapperClassName,
      sticky = false,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const [internal, setInternal] = React.useState<Density>(defaultDensity);
    const isControlled = densityProp !== undefined;
    const density = isControlled ? densityProp : internal;

    const setDensity = React.useCallback(
      (level: Density) => {
        if (!isControlled) setInternal(level);
        onDensityChange?.(level);
      },
      [isControlled, onDensityChange],
    );

    const ctx = React.useMemo<TableDensityContextValue>(
      () => ({ density, setDensity }),
      [density, setDensity],
    );

    return (
      <TableDensityContext.Provider value={ctx}>
        <div
          className={cn(
            "table-scroll w-full overflow-x-auto",
            sticky && "tbl-enh max-h-[min(62vh,660px)] overflow-y-auto",
            densityClass[density],
            wrapperClassName,
          )}
          data-density={density}
        >
          <table
            ref={ref}
            className={cn("w-full border-collapse text-left", className)}
            {...props}
          >
            {children}
          </table>
        </div>
      </TableDensityContext.Provider>
    );
  },
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn(className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn(className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "last:[&_td]:border-b-0",
      "[&[data-clickable]]:cursor-pointer [&[data-clickable]]:transition-colors",
      "[&[data-clickable]:hover]:bg-surface-2",
      "[&[data-selected=true]]:bg-accent-soft",
      className,
    )}
    {...props}
  />
));
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "whitespace-nowrap border-b border-border px-[18px] py-[14px] align-middle",
      "text-[11px] font-bold uppercase tracking-wide text-soft",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "border-b border-border px-[18px] py-[14px] align-middle text-[13px] text-fg",
      className,
    )}
    {...props}
  />
));
TableCell.displayName = "TableCell";

export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
};
