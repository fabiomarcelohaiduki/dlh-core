import { formatRecurso } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Valor do filtro de recurso: "todos" (sem filtro) ou um recurso especifico. */
export type RecursoFiltroValue = "todos" | string;

/**
 * cmp-recurso-filtro — Filtro segmentado por recurso/tipo da fonte.
 *
 * Os recursos disponiveis sao derivados da propria lista carregada (ex.:
 * 'processos' do Nomus). Aplica client-side sobre a lista origem-aware. Quando
 * nao ha recursos distintos, exibe apenas "Todos".
 */
export function RecursoFiltro({
  recursos,
  value,
  onChange,
}: {
  recursos: string[];
  value: RecursoFiltroValue;
  onChange: (value: RecursoFiltroValue) => void;
}) {
  // Com 0 ou 1 recurso nao ha escolha real: o "Todos" fica redundante -> oculta.
  if (recursos.length <= 1) return null;
  const options: RecursoFiltroValue[] = ["todos", ...recursos];
  return (
    <div className="filter-group" role="group" aria-label="Filtrar por recurso">
      {options.map((opt) => {
        const active = value === opt;
        return (
          <button
            key={opt}
            type="button"
            className={cn("btn", "btn-sm", active && "btn-primary")}
            aria-pressed={active}
            onClick={() => onChange(opt)}
          >
            {opt === "todos" ? "Todos os recursos" : formatRecurso(opt)}
          </button>
        );
      })}
    </div>
  );
}
