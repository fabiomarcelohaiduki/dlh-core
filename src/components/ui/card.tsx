import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Card / Panel — container padrao do design system (D-FE-03).
 *
 * Renderiza com bg-surface, borda (token --border) e rounded-md (12px,
 * mapeado a --r-md). Sem cores hardcoded: tudo via tokens semanticos.
 * `Panel` e um alias semantico do mesmo primitivo (mesma materialidade),
 * para uso em areas de configuracao/agrupamento.
 */
export type CardProps = React.HTMLAttributes<HTMLDivElement>;

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-md border border-border bg-surface p-[18px] shadow-[var(--shadow-card),var(--hairline-top)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ),
);
Card.displayName = "Card";

const Panel = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-md border border-border bg-surface",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ),
);
Panel.displayName = "Panel";

export { Card, Panel };
