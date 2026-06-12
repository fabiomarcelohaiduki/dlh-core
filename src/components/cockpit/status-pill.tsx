import { cn } from "@/lib/utils";
import type { PillState } from "@/lib/status";

/**
 * cmp-status-pill — Pill de status.
 *
 * Unica fonte de verdade do mapeamento ESTADO -> TOKEN DE COR do Design Lock.
 * Os estados travados (ok/run/warn/err/idle) correspondem 1:1 as classes
 * `.pill.<estado>` em globals.css, que referenciam as variaveis de cor
 * travadas (--ok/--run/--warn/--err/--idle). Nenhum outro componente deve
 * decidir cor de status: todos derivam um PillState e passam para ca.
 */
const STATE_CLASS: Record<PillState, string> = {
  ok: "ok",
  run: "run",
  warn: "warn",
  err: "err",
  idle: "idle",
};

export function StatusPill({
  state,
  label,
  className,
  iconOnly = false,
}: {
  state: PillState;
  label: string;
  className?: string;
  iconOnly?: boolean;
}) {
  return (
    <span
      className={cn("pill", STATE_CLASS[state], iconOnly && "icon-only", className)}
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
    >
      <span className="dot" aria-hidden="true" />
      {iconOnly ? null : label}
    </span>
  );
}
