"use client";

// =====================================================================
// ArestaBadge - badge colorido por tipo de chave da aresta.
//
// Mantem 3 variantes canonicas:
//   - metodo: deterministico | embedding (cor solida)
//   - relacao: neutro (pill discreto)
//   - confianca: alto (>=0.85 verde) | medio (>=0.6 amber) | baixo (<0.6 cinza)
//
// Sem hex hardcoded: usa os tokens do design system (accent, muted, etc).
// =====================================================================

import { cn } from "@/lib/utils";

export interface ArestaBadgeProps {
  /** Conteudo textual exibido dentro do badge. */
  children: React.ReactNode;
  /** Variante visual canonica. */
  variant: "metodo-determin" | "metodo-embedding" | "relacao" | "conf-alta" | "conf-media" | "conf-baixa";
  className?: string;
}

const VARIANTE_CLASS: Record<ArestaBadgeProps["variant"], string> = {
  "metodo-determin": "bg-[color-mix(in_oklch,var(--accent)_18%,transparent)] text-accent-strong",
  "metodo-embedding": "bg-[color-mix(in_oklch,#38bdf8_18%,transparent)] text-[color:var(--accent-strong)]",
  "relacao": "bg-[color-mix(in_oklch,var(--fg)_10%,transparent)] text-muted",
  "conf-alta": "bg-[color-mix(in_oklch,#22c55e_18%,transparent)] text-[color:#22c55e]",
  "conf-media": "bg-[color-mix(in_oklch,#f5a524_18%,transparent)] text-[color:#f5a524]",
  "conf-baixa": "bg-[color-mix(in_oklch,#71717a_18%,transparent)] text-[color:#71717a]",
};

/**
 * Badge pequeno (padding vertical de 1px, font 10.5px). Usado em tabelas
 * densas. Largura se adapta ao conteudo (whitespace-nowrap no caller).
 */
export function ArestaBadge({ children, variant, className }: ArestaBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
        "text-[10.5px] font-semibold tracking-wide whitespace-nowrap",
        VARIANTE_CLASS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}