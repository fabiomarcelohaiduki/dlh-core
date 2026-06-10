import { formatRecurso } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Valor do filtro de recurso: "todos" (sem filtro) ou um recurso especifico. */
export type RecursoFiltroValue = "todos" | string;

/**
 * cmp-recurso-filtro — Filtro por recurso/tipo da fonte, em toggle.
 *
 * Os recursos disponiveis sao derivados da propria lista carregada (ex.:
 * 'processos' do Nomus). Sem pill "Todos": a origem ja traz todos os recursos;
 * clicar um recurso filtra, clicar o mesmo de novo remove o filtro ("todos").
 * Quando nao ha recursos distintos, oculta.
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
  // Sem recurso para a origem selecionada nao ha o que filtrar -> oculta.
  if (recursos.length === 0) return null;
  return (
    <div className="filter-group" role="group" aria-label="Filtrar por recurso">
      {recursos.map((opt) => {
        const active = value === opt;
        return (
          <button
            key={opt}
            type="button"
            className={cn("btn", "btn-sm", active && "btn-primary")}
            aria-pressed={active}
            onClick={() => onChange(active ? "todos" : opt)}
          >
            {formatRecurso(opt)}
          </button>
        );
      })}
    </div>
  );
}
