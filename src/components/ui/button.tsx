import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Button no padrao shadcn/ui, mapeado aos tokens semanticos do Design Lock.
 * Espelha as classes .btn do artifact (height 38, radius sm, acento ambar).
 *
 * Sem hex hardcoded: as cores resolvem via tokens CSS (`var(--token)`)
 * expostos pelo Tailwind (bg-accent, text-accent-fg, hover:bg-accent-soft,
 * hover:border-accent-soft, hover:border-border). Isso preserva o gate
 * RNF-19 e mantem coerencia com light/dark via :root / .dark.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-sm whitespace-nowrap rounded-sm text-[13.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-border bg-surface-2 text-fg hover:bg-accent-soft hover:border-accent-soft hover:border-border active:translate-y-px",
        primary:
          "border border-accent bg-accent font-semibold text-accent-fg hover:bg-accent-soft hover:border-accent-soft active:translate-y-px",
        ghost:
          "border border-transparent bg-transparent text-fg hover:bg-surface-2 hover:border-border",
        icon:
          "aspect-square justify-center !px-0 border border-border bg-surface-2 text-fg hover:bg-accent-soft hover:border-border active:translate-y-px",
      },
      size: {
        default: "h-[38px] px-4",
        sm: "h-[30px] px-[11px] text-[12.5px]",
        md: "h-[38px] px-4",
        lg: "h-[44px] px-5 text-[14px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };