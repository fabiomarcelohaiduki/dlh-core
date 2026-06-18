import type { Veredito } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/** Valor do filtro de veredito: "todos" (sem filtro) ou um veredito especifico. */
export type VereditoFiltroValue = "todos" | Veredito;

const OPTIONS: { value: VereditoFiltroValue; label: string }[] = [
  { value: "todos", label: "Todos" },
  { value: "util", label: "Útil" },
  { value: "duvida", label: "Dúvida" },
  { value: "lixo", label: "Lixo" },
];

/**
 * cmp-veredito-filtro — Filtro segmentado por veredito (Todos/Útil/Dúvida/Lixo),
 * no molde travado dos filtros (btn / btn-sm / btn-primary + aria-pressed). O
 * filtro e aplicado client-side sobre a lista ja carregada.
 */
export function VereditoFiltro({
  value,
  onChange,
}: {
  value: VereditoFiltroValue;
  onChange: (value: VereditoFiltroValue) => void;
}) {
  return (
    <div
      className="filter-group segmented"
      role="group"
      aria-label="Filtrar por veredito"
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            className={cn("btn", "btn-sm", active && "btn-primary")}
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
