"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Tabs composto do design system (D-FE-04).
 *
 * Espelha o `.tabs` / `.tab` do artifact: guias com `border-bottom` e a guia
 * ativa marcada por `border-bottom-color: accent` + texto em accent-strong.
 * Suporta contador opcional por guia (`.tab-count`). Sem hex hardcoded.
 *
 * Acessibilidade: `role="tablist"` + `role="tab"`, com roving tabindex e
 * navegacao por teclado (setas Esquerda/Direita, Home/End). Estados
 * mutuamente exclusivos pelo valor ativo.
 */

export interface TabItem<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Contador opcional exibido como badge a direita do rotulo. */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  value: T;
  items: ReadonlyArray<TabItem<T>>;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}

export function Tabs<T extends string>({
  value,
  items,
  onValueChange,
  ariaLabel,
  className,
}: TabsProps<T>) {
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
        "flex gap-0.5 overflow-x-auto border-b border-border px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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
              "inline-flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent bg-transparent px-3 py-[13px]",
              "text-[13px] font-semibold text-muted transition-colors",
              "hover:text-fg focus-visible:outline-none focus-visible:text-fg",
              "disabled:pointer-events-none disabled:opacity-50",
              active && "border-accent text-accent-strong",
            )}
          >
            {item.label}
            {typeof item.count === "number" ? (
              <span
                className={cn(
                  "rounded-[6px] px-1.5 py-px text-[11px] font-bold tabular-nums",
                  active
                    ? "bg-accent-soft text-accent-strong"
                    : "bg-[color-mix(in_oklch,var(--fg)_8%,transparent)] text-soft",
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
