import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Alert composto do design system (D-FE-04).
 *
 * Banner inline com semantica ok / warn / danger (+ info neutro), ancorado
 * nos tokens de estado do Design Lock (--ok, --warn, --err e seus -bg).
 * Sem hex hardcoded: a cor de cada variante resolve via Tailwind/tokens.
 *
 * Acessibilidade: `role="alert"` para danger/warn (assertivo) e
 * `role="status"` para ok/info (polido), espelhando a urgencia do conteudo.
 */
const alertVariants = cva(
  "flex items-start gap-3 rounded-md border p-[14px] text-[13px] leading-relaxed",
  {
    variants: {
      variant: {
        ok: "border-ok/40 bg-ok-bg text-fg [&_[data-alert-icon]]:text-ok",
        warn: "border-warn/40 bg-warn-bg text-fg [&_[data-alert-icon]]:text-warn",
        danger: "border-err/40 bg-err-bg text-fg [&_[data-alert-icon]]:text-err",
        info: "border-border bg-surface-2 text-fg [&_[data-alert-icon]]:text-muted",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  },
);

const variantIcon: Record<
  NonNullable<VariantProps<typeof alertVariants>["variant"]>,
  LucideIcon
> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  danger: XCircle,
  info: Info,
};

const variantRole: Record<
  NonNullable<VariantProps<typeof alertVariants>["variant"]>,
  "alert" | "status"
> = {
  ok: "status",
  info: "status",
  warn: "alert",
  danger: "alert",
};

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof alertVariants> {
  /** Titulo opcional em negrito acima do conteudo. */
  title?: React.ReactNode;
  /** Oculta o icone semantico. */
  hideIcon?: boolean;
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  (
    { className, variant = "info", title, hideIcon = false, children, ...props },
    ref,
  ) => {
    const safeVariant = variant ?? "info";
    const Icon = variantIcon[safeVariant];
    return (
      <div
        ref={ref}
        role={variantRole[safeVariant]}
        className={cn(alertVariants({ variant }), className)}
        {...props}
      >
        {!hideIcon ? (
          <Icon
            data-alert-icon
            aria-hidden="true"
            className="mt-px size-4 flex-none"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          {title ? (
            <p className="mb-0.5 font-semibold text-fg">{title}</p>
          ) : null}
          {children}
        </div>
      </div>
    );
  },
);
Alert.displayName = "Alert";

export { Alert, alertVariants };
