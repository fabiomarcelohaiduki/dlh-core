"use client";

// =====================================================================
// ArestaAcoes - botoes de acao por linha de aresta na tabela da
// sub-aba Arestas.
//
// Acoes oferecidas:
//   - ⌖ (Crosshair): focar o no de origem (ou destino, se origem for
//     o proprio no selecionado) no grafo. Dispara callback onFocus.
//   - ⓘ (Info): placeholder para detalhe da aresta (sem tela propria
//     por enquanto — dispara onDetalhes como hook futuro).
//
// Botoes sao icon-only (padrao das tabelas do cockpit), com titulo
// via title= e aria-label para acessibilidade.
// =====================================================================

import { Crosshair, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ArestaAcoesProps {
  onFocus: () => void;
  onDetalhes?: () => void;
  className?: string;
}

export function ArestaAcoes({ onFocus, onDetalhes, className }: ArestaAcoesProps) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <button
        type="button"
        onClick={onFocus}
        title="Focar no grafo"
        aria-label="Focar no grafo"
        data-btn="aresta-focus"
        className={cn(
          "inline-grid size-7 place-items-center rounded-md",
          "border border-transparent text-muted",
          "transition-colors hover:bg-[color-mix(in_oklch,var(--fg)_8%,transparent)] hover:text-fg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]",
        )}
      >
        <Crosshair className="size-[14px]" aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={onDetalhes}
        disabled={!onDetalhes}
        title="Detalhes da aresta"
        aria-label="Detalhes da aresta"
        data-btn="aresta-detalhes"
        className={cn(
          "inline-grid size-7 place-items-center rounded-md",
          "border border-transparent text-muted",
          "transition-colors hover:bg-[color-mix(in_oklch,var(--fg)_8%,transparent)] hover:text-fg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]",
          "disabled:cursor-not-allowed disabled:opacity-40",
        )}
      >
        <Info className="size-[14px]" aria-hidden="true" />
      </button>
    </span>
  );
}