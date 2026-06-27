import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Select atomico do design system (D-FE-03), paritario com o Input.
 * Mantem os mesmos estados (default / focus / disabled / error) e ancoragem
 * por tokens semanticos do Design Lock.
 *
 * Sem hex hardcoded: cores via tokens CSS (bg-surface-2, border-border,
 * text-fg, foco com ring accent-line). O chevron e um SVG inline em
 * `currentColor` (text-muted), tambem sem cor literal. O estado `error`
 * reancora para os tokens de erro (--err).
 */
export const selectVariants = cva(
  "w-full h-10 pl-[13px] pr-9 rounded-sm bg-surface-2 text-fg text-[13.5px] appearance-none shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)] transition-[border-color,box-shadow,background] outline-none disabled:opacity-50 disabled:cursor-not-allowed",
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

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement>,
    VariantProps<typeof selectVariants> {}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, state, children, ...props }, ref) => (
    <div className="relative w-full">
      <select
        ref={ref}
        className={cn(selectVariants({ state, className }))}
        {...props}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute right-3 top-1/2 size-3 -translate-y-1/2 text-muted"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  ),
);
Select.displayName = "Select";

export { Select };
