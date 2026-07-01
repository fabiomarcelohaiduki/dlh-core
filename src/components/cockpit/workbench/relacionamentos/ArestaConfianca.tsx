"use client";

// =====================================================================
// ArestaConfianca - barra + numero tabular para visualizacao rapida da
// confianca de uma aresta (0..1). A barra assume 100% da largura do
// container pai e usa a cor padrao do design system quando confianca
// >= 0.85 (alta); abaixo disso escurece para indicar "atencao".
//
// Largura da barra e 56px (compativel com a coluna estreita da tabela).
// =====================================================================

import { cn } from "@/lib/utils";

export interface ArestaConfiancaProps {
  /** Confianca normalizada em [0, 1]. */
  value: number;
  className?: string;
}

/** Largura fixa da barra em pixels (coluna estreita de tabela). */
const BAR_WIDTH_PX = 56;

/** Cor da barra segundo a faixa de confianca. */
function corDaBarra(value: number): string {
  if (value >= 0.85) return "var(--accent)";
  if (value >= 0.6) return "var(--warn)";
  return "var(--faint)";
}

export function ArestaConfianca({ value, className }: ArestaConfiancaProps) {
  // Clamp defensivo (arestas vindas do backend ja vem em [0,1], mas o
  // caller pode passar valor fora da faixa em mocks).
  const clamped = Math.max(0, Math.min(1, value));
  const cor = corDaBarra(clamped);

  return (
    <span className={cn("inline-flex items-center gap-2 font-variant-numeric tabular-nums", className)}>
      <span
        aria-hidden="true"
        className="relative inline-block h-[5px] overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--fg)_10%,transparent)]"
        style={{ width: `${BAR_WIDTH_PX}px` }}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${clamped * 100}%`, background: cor }}
        />
      </span>
      <span className="text-[12.5px] text-fg">{clamped.toFixed(2)}</span>
    </span>
  );
}