import type { OrigemKey } from "@/lib/status";
import { cn } from "@/lib/utils";

/** Valor do filtro de origem: "todas" (sem filtro) ou uma origem especifica. */
export type OrigemFiltroValue = "todas" | OrigemKey;

const OPTIONS: { value: OrigemFiltroValue; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "effecti", label: "Effecti" },
  { value: "nomus", label: "Nomus" },
  { value: "gmail", label: "Gmail" },
];

/**
 * cmp-origem-filtro — Filtro segmentado por origem (Effecti x Nomus x Gmail).
 *
 * Reaproveita o padrao de filtro travado das telas (btn / btn-sm / btn-primary).
 * O filtro e aplicado client-side sobre a lista ja carregada (origem-aware).
 */
export function OrigemFiltro({
  value,
  onChange,
}: {
  value: OrigemFiltroValue;
  onChange: (value: OrigemFiltroValue) => void;
}) {
  return (
    <div className="filter-group" role="group" aria-label="Filtrar por origem">
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
