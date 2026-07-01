"use client";

// =====================================================================
// GrafoLegenda - legenda fixa dos 3 estados visuais dos nos do grafo.
//
//   1) Vinculado  - no com arestas confirmadas; cor cheia + borda solida
//   2) Sem_match  - no sem arestas por regra; cor cheia + borda dashed
//   3) Lixo       - no descartado/inativo; cinza #71717a
//
// Renderizada como pílulas pequenas no canto inferior esquerdo do
// canvas. Sem hex hardcoded onde existe token equivalente (RNF-19).
// =====================================================================

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------
// Tipos e constantes locais.
// ---------------------------------------------------------------------

export interface GrafoLegendaProps {
  className?: string;
}

interface ItemLegenda {
  id: string;
  label: string;
  /** Cor de preenchimento do no. */
  fill: string;
  /** Estilo da borda do no. */
  borderStyle: "solid" | "dashed";
}

const ITENS: ItemLegenda[] = [
  {
    id: "vinculado",
    label: "Vinculado",
    fill: "#e27300",
    borderStyle: "solid",
  },
  {
    id: "sem_match",
    label: "Sem match",
    fill: "#facc15",
    borderStyle: "dashed",
  },
  {
    id: "lixo",
    label: "Lixo",
    fill: "#71717a",
    borderStyle: "solid",
  },
];

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function GrafoLegenda({ className }: GrafoLegendaProps) {
  return (
    <div
      data-grafo-legenda
      aria-label="Legenda do grafo"
      className={cn(
        "pointer-events-none flex items-center gap-2 rounded-md border border-border bg-surface/85 px-3 py-2 backdrop-blur",
        "shadow-[var(--shadow-tooltip)]",
        className,
      )}
    >
      {ITENS.map((item) => (
        <span
          key={item.id}
          className="inline-flex items-center gap-1.5 text-[11.5px] text-muted"
        >
          <span
            aria-hidden="true"
            className="inline-block size-3 flex-none rounded-full"
            style={{
              background: item.fill,
              border:
                item.borderStyle === "dashed"
                  ? `2px dashed ${item.fill}`
                  : `2px solid ${item.fill}`,
              boxShadow:
                item.id === "vinculado"
                  ? "0 0 8px color-mix(in srgb, #e27300 50%, transparent)"
                  : "none",
            }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}