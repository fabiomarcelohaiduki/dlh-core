"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Subtabs composto do design system (D-FE-04, delta-31/32).
 *
 * Idioma "aba de pasta": as guias se conectam visualmente ao card abaixo. A
 * guia ativa usa fundo surface, borda e `border-radius: 10px 10px 0 0`, com
 * `margin-bottom: -1px` para encostar (e cobrir a borda do) card logo abaixo,
 * alem de uma faixa de accent no topo. Estados mutuamente exclusivos pelo
 * valor ativo. Sem hex hardcoded.
 *
 * Para o efeito de pasta, o card sob estas guias deve ter os cantos
 * superiores retos (`rounded-t-none`) — espelha #panel-coleta no artifact.
 *
 * Acessibilidade: `role="tablist"` + `role="tab"` com roving tabindex e
 * navegacao por teclado (setas, Home/End).
 */

export interface SubtabItem<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Contador opcional (`.st-count`). */
  count?: number;
  disabled?: boolean;
}

export interface SubtabsProps<T extends string> {
  value: T;
  items: ReadonlyArray<SubtabItem<T>>;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}

export function Subtabs<T extends string>({
  value,
  items,
  onValueChange,
  ariaLabel,
  className,
}: SubtabsProps<T>) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  function move(from: number, dir: 1 | -1) {
    const total = items.length;
    let next = from;
    for (let i = 0; i < total; i++) {
      next = (next + dir + total) % total;
      if (!items[next]?.disabled) break;
    }
    const target = items[next];
    if (target && !target.disabled) {
      onValueChange(target.value);
      refs.current[next]?.focus();
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(index, 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(items.length - 1, 1);
    } else if (event.key === "End") {
      event.preventDefault();
      move(0, -1);
    }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "relative z-[2] -mb-px flex items-stretch gap-1",
        className,
      )}
    >
      {items.map((item, index) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex items-center gap-2 rounded-t-[10px] border border-b-0 border-transparent bg-transparent px-4 py-2.5",
              "text-[14px] font-semibold text-muted transition-colors",
              "hover:text-fg focus-visible:outline-none focus-visible:text-fg",
              "disabled:pointer-events-none disabled:opacity-50",
              active &&
                "border-border border-t-2 border-t-accent bg-surface pt-[9px] text-accent-strong",
            )}
          >
            {item.label}
            {typeof item.count === "number" ? (
              <span
                className={cn(
                  "rounded-[6px] px-[7px] py-px text-[11px] font-bold tabular-nums",
                  active
                    ? "bg-accent-soft text-accent-strong"
                    : "bg-[color-mix(in_oklch,var(--fg)_9%,transparent)] text-soft",
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
