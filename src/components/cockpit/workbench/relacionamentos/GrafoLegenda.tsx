"use client";

// =====================================================================
// GrafoLegenda - legenda dinamica do grafo por TIPO de no (F4).
//
// Consome useRelacionamentosAbreviacoes (GET /relacionamentos-abreviacoes) e
// renderiza, por tipo, a cor semantica (swatch) + a abreviacao curta. O nome
// completo do tipo fica no tooltip nativo (title), conforme §4.12/§4.14.
//
// Editar abreviacao/cor no editor propaga para esta legenda no proximo read
// (a mutacao PATCH invalida a query de abreviacoes; nao e realtime).
//
// A legenda captura ponteiro APENAS no seu proprio retangulo (para os
// tooltips funcionarem), sem bloquear a interacao com o restante do canvas.
// =====================================================================

import { useRelacionamentosAbreviacoes } from "@/hooks/relacionamentos";
import { cn } from "@/lib/utils";
import { COR_SEMANTICA_FALLBACK, tipoNoLabel } from "./tipo-no-meta";

export interface GrafoLegendaProps {
  className?: string;
}

/** Deriva o rotulo curto exibido no chip (abreviacao ou nome capitalizado). */
function chipLabel(tipo: string, abreviacao: string | null): string {
  const abrev = abreviacao?.trim();
  if (abrev && abrev.length > 0) return abrev;
  return tipoNoLabel(tipo);
}

export function GrafoLegenda({ className }: GrafoLegendaProps) {
  const { data, isLoading } = useRelacionamentosAbreviacoes();
  const tipos = data?.tipos ?? [];

  // Sem dados e sem carregar: nao polui o canvas.
  if (!isLoading && tipos.length === 0) return null;

  return (
    <div
      data-grafo-legenda
      aria-label="Legenda do grafo por tipo"
      className={cn(
        "pointer-events-auto flex max-w-[70vw] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-surface/85 px-3 py-2 backdrop-blur",
        "shadow-[var(--shadow-tooltip)]",
        className,
      )}
    >
      {isLoading
        ? Array.from({ length: 4 }).map((_, i) => (
            <span
              key={`legenda-skel-${i}`}
              aria-hidden="true"
              className="inline-flex items-center gap-1.5"
            >
              <span className="inline-block size-3 animate-pulse rounded-full bg-surface-3" />
              <span className="inline-block h-3 w-12 animate-pulse rounded-sm bg-surface-3" />
            </span>
          ))
        : tipos.map((t) => {
            const cor = t.cor_semantica?.trim() || COR_SEMANTICA_FALLBACK;
            const nome = tipoNoLabel(t.tipo);
            return (
              <span
                key={t.tipo}
                data-tipo={t.tipo}
                title={nome}
                className="inline-flex items-center gap-1.5 text-[11.5px] text-muted"
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-3 flex-none rounded-full border-2"
                  style={{ background: cor, borderColor: cor }}
                />
                <span className="font-medium text-fg">
                  {chipLabel(t.tipo, t.abreviacao_padrao)}
                </span>
              </span>
            );
          })}
    </div>
  );
}
