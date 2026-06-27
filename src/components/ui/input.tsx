import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Input atomico do design system (D-FE-03), mapeado aos tokens semanticos do
 * Design Lock. Espelha os estados do artifact (altura 40, surface-2, borda
 * token, foco com ring accent).
 *
 * Sem hex hardcoded: cores resolvem via tokens CSS expostos pelo Tailwind
 * (bg-surface-2, border-border, text-fg, placeholder:text-muted,
 * focus ring accent-line / border-accent-line). O estado `error` troca o
 * ancoramento de cor para os tokens de erro (--err).
 */
export const inputVariants = cva(
  "w-full h-10 px-[13px] rounded-sm bg-surface-2 text-fg text-[13.5px] placeholder:text-muted shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)] transition-[border-color,box-shadow,background] outline-none disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      state: {
        default:
          "border border-border hover:border-border-strong focus-visible:border-accent-line focus-visible:ring-2 focus-visible:ring-accent-line",
        error:
          "border border-err focus-visible:border-err focus-visible:ring-2 focus-visible:ring-err-bg",
      },
    },
    defaultVariants: {
      state: "default",
    },
  },
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, state, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(inputVariants({ state, className }))}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
