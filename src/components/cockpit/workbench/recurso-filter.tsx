"use client";

// =====================================================================
// RecursoFilter — sub-filtro de recurso da fonte (single-select).
//
// Aparece na banda "topo" quando a fonte selecionada tem recurso (ex.: Nomus:
// Pessoas, Processos, Ordens de compra, Cotações, Notas fiscais). Ocupa a
// propria linha abaixo das abas de fonte (basis-full + order-last) e espelha o
// .res-filter do protótipo: rotulo "Recurso" + pílula "Todos" com o total +
// uma pílula por recurso com a contagem. O caller deriva as opcoes do dado
// real e so monta o filtro quando ha recursos.
// =====================================================================

import { cn } from "@/lib/utils";

export interface RecursoOption {
  value: string;
  label: string;
  count: number;
}

export interface RecursoFilterProps {
  options: RecursoOption[];
  /** Total de execuções/itens da fonte (contagem da pílula "Todos"). */
  total: number;
  /** Recurso ativo ("todos" ou o valor de um recurso). */
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
}

const ALL = "todos";

function pillClass(active: boolean): string {
  return cn(
    "rounded-full border px-3 py-[5px] text-[12.5px] font-medium transition-colors",
    active
      ? "border-accent bg-accent font-semibold text-on-accent"
      : "border-border bg-surface text-muted hover:border-[color-mix(in_oklch,var(--accent)_45%,var(--border))] hover:text-fg",
  );
}

export function RecursoFilter({
  options,
  total,
  value,
  onValueChange,
  ariaLabel,
}: RecursoFilterProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="order-last -mt-2 mb-1.5 flex basis-full flex-wrap items-center gap-[7px] rounded-[10px] border border-[color-mix(in_oklch,var(--border)_80%,transparent)] bg-[color-mix(in_oklch,var(--surface)_60%,transparent)] px-3 py-1.5"
    >
      <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-soft">
        Recurso
      </span>
      <button
        type="button"
        role="radio"
        aria-checked={value === ALL}
        onClick={() => onValueChange(ALL)}
        className={pillClass(value === ALL)}
      >
        Todos
        <span className="ml-[5px] tabular-nums opacity-70">{total}</span>
      </button>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onValueChange(opt.value)}
          className={pillClass(value === opt.value)}
        >
          {opt.label}
          <span className="ml-[5px] tabular-nums opacity-70">{opt.count}</span>
        </button>
      ))}
    </div>
  );
}
