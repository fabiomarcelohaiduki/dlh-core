import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Pill / status-pill atomico (D-FE-03).
 *
 * Mapeia a semantica (ok / warn / danger / accent) para o sistema global de
 * pills do Design Lock (`.pill.<estado>` em globals.css), unica fonte de
 * verdade do par ESTADO -> TOKEN DE COR. Nenhuma cor literal: as classes
 * globais referenciam --ok / --warn / --err / --accent.
 *
 * A regra global `body.highlight-pending .pill.warn` reforca contorno e peso
 * de toda pendencia quando o destaque esta ligado — por isso o estado `warn`
 * resolve para `.pill.warn`.
 */
export const pillVariants = cva("pill", {
  variants: {
    variant: {
      ok: "ok",
      warn: "warn",
      danger: "err",
      accent: "accent",
    },
  },
  defaultVariants: {
    variant: "accent",
  },
});

export interface PillProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof pillVariants> {
  /** Exibe o ponto indicador a esquerda do rotulo. */
  dot?: boolean;
}

const Pill = React.forwardRef<HTMLSpanElement, PillProps>(
  ({ className, variant, dot = false, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(pillVariants({ variant }), className)}
      {...props}
    >
      {dot ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  ),
);
Pill.displayName = "Pill";

export { Pill };
