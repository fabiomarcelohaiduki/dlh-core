"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Segmented control atomico (D-FE-03).
 *
 * Renderiza opcoes mutuamente exclusivas com a opcao ativa destacada.
 * Usa o sistema global `.cc-seg` do Design Lock (trilho + botoes), que ja
 * consome os tokens semanticos (--surface, --border, --fg, --muted) sem hex.
 *
 * Acessibilidade: `role="group"` com `aria-label`; cada opcao e um botao com
 * `aria-pressed` refletindo o valor atual. Totalmente controlado.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  disabled = false,
  className,
}: {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (next: T) => void;
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("cc-seg", className)}
      id={id}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}
