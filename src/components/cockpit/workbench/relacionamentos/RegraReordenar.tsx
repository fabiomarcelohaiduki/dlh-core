"use client";

// =====================================================================
// RegraReordenar - exibicao minimalista da ordem atual das regras no
// catalogo (campo versao/created_at) com setas up/down locais.
//
// O backend ainda nao expoe um endpoint dedicado de reordenacao (a coluna
// `ordem` nao existe na migration da sprint 002); portanto, esta sprint
// entrega a UI minima conforme spec ("renderiza ordem atual em texto, sem
// interacao"). As setas ficam em estado disabled, com tooltip avisando
// que a reordenacao sera adicionada em sprint futura. Quando o backend
// disponibilizar a operacao, basta trocar o onClick de disabled pelos
// hooks `useRelacionamentosReorder()` correspondentes.
// =====================================================================

import { ChevronDown, ChevronUp, ListOrdered } from "lucide-react";
import { Pill } from "@/components/ui/pill";
import type { Regra } from "@/lib/api/relacionamentos-types";

export function RegraReordenar({ regras }: { regras: ReadonlyArray<Regra> }) {
  /**
   * Implementacao minima: ordena por `updated_at` descendente e exibe a
   * posicao atual como texto. Quando o backend ganhar uma coluna `ordem`,
   * basta trocar essa derivacao pelo campo persistido.
   */
  const ordenadas = [...regras].sort((a, b) =>
    (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  );

  if (ordenadas.length === 0) {
    return null;
  }

  return (
    <section
      data-componente="regra-reordenar"
      aria-label="Ordem atual das regras"
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-2/40 p-3"
    >
      <header className="flex items-center gap-2">
        <ListOrdered className="size-4 text-muted" aria-hidden="true" />
        <span className="text-[12.5px] font-semibold text-fg">
          Ordem atual das regras
        </span>
        <Pill variant="neutral" className="text-[11px]">
          {ordenadas.length}
        </Pill>
      </header>
      <ol className="flex flex-col gap-1.5">
        {ordenadas.map((r, idx) => (
          <li
            key={r.id}
            className="flex items-center justify-between gap-2 rounded-sm border border-border bg-surface px-2.5 py-1.5"
            data-ordem-regra-item={r.id}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="w-7 flex-none text-center text-[11px] font-bold tabular-nums text-muted">
                {idx + 1}
              </span>
              <span className="truncate text-[12.5px] text-fg">
                {r.nome?.trim() ||
                  `${r.origem_tipo}.${r.campo_origem} → ${r.destino_tipo}.${r.campo_destino}`}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                aria-label={`Mover "${r.nome ?? r.campo_destino}" para cima`}
                disabled
                title="Reordenação indisponível nesta sprint"
                className="grid size-6 cursor-not-allowed place-items-center rounded-sm border border-border bg-surface text-muted opacity-50"
              >
                <ChevronUp className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Mover "${r.nome ?? r.campo_destino}" para baixo`}
                disabled
                title="Reordenação indisponível nesta sprint"
                className="grid size-6 cursor-not-allowed place-items-center rounded-sm border border-border bg-surface text-muted opacity-50"
              >
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[11.5px] text-faint">
        A reordenação interativa chega em sprint futura - a coluna de ordem no
        catalogo ainda não foi exposta pelo backend.
      </p>
    </section>
  );
}
