"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Toggle atomico (switch) do design system (D-FE-03).
 *
 * Acessibilidade: `role="switch"` com `aria-pressed` (alvo do estilo de estado
 * ligado) e `aria-checked` espelhado para leitores de tela. `aria-label`
 * obrigatorio descreve a preferencia controlada.
 *
 * Sem hex hardcoded: o trilho usa --border / --accent e o knob usa --muted
 * (off) / --accent-fg (on), todos via tokens semanticos. O estado mudo e
 * obtido aplicando `.cc-row.is-muted` (opacity .5 + pointer-events:none) na
 * linha que envolve o toggle — mantido coerente com o Design Lock.
 */
export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(
  ({ checked, onChange, ariaLabel, id, disabled = false, className }, ref) => (
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props
    <button
      ref={ref}
      type="button"
      id={id}
      role="switch"
      aria-pressed={checked}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[22px] w-[38px] shrink-0 rounded-full border transition-[background,border-color] duration-150 outline-none cursor-pointer disabled:cursor-not-allowed",
        "focus-visible:ring-2 focus-visible:ring-accent-line",
        "after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:transition-transform after:duration-150 after:content-['']",
        checked
          ? "border-accent bg-accent after:translate-x-4 after:bg-accent-fg"
          : "border-border bg-surface-3 after:bg-muted",
        className,
      )}
    />
  ),
);
Toggle.displayName = "Toggle";

export { Toggle };
