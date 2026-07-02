"use client";

// =====================================================================
// VinculoFiltros - barra de filtros da listagem de vinculos inferidos
// pela Lia (vinculos_inferidos_lia).
//
// Campos (controlados, mobile-first):
//   - status             (select: todos / rascunho / ativo / descartado)
//   - origem             (select: todos / lia / humano)
//   - contador_uso_min   (number input, >= 0)
//   - contador_uso_max   (number input, >= 0)
//
// O componente e CONTROLADO: o pai (RelacionamentosVinculosLiaView)
// detem o estado dos filtros e passa `value` + `onChange`. O botao
// "Limpar filtros" reseta todos os campos para o estado vazio inicial
// (sem filtro). Quando algum filtro esta ativo, um contador discreto
// e exibido para feedback rapido.
//
// Mobile-first: empilhado vertical ate `sm:` (>= 640px), onde vira
// uma grade 1fr / 1fr / 120px / 120px / auto. Inputs usam largura
// cheia no mobile para area de toque adequada.
// =====================================================================

import { Eraser, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Status possiveis para o filtro de vinculos Lia (espelha o backend). */
export type VinculoFiltroStatus = "todos" | "rascunho" | "ativo" | "descartado";

/** Origem possivel para o filtro de vinculos Lia (espelha o backend). */
export type VinculoFiltroOrigem = "todos" | "lia" | "humano";

/** Estado completo dos filtros de vinculos Lia. */
export interface VinculoFiltrosValue {
  status: VinculoFiltroStatus;
  origem: VinculoFiltroOrigem;
  contador_uso_min: string;
  contador_uso_max: string;
}

/** Estado inicial limpo (sem filtros aplicados). */
export const VINCULO_FILTROS_INICIAL: VinculoFiltrosValue = {
  status: "todos",
  origem: "todos",
  contador_uso_min: "",
  contador_uso_max: "",
};

/** Opcoes dos selects - declaradas aqui para reuso e consistencia visual. */
const STATUS_OPCOES: ReadonlyArray<{ value: VinculoFiltroStatus; label: string }> = [
  { value: "todos", label: "Todos os status" },
  { value: "rascunho", label: "Rascunho" },
  { value: "ativo", label: "Ativo" },
  { value: "descartado", label: "Descartado" },
];

const ORIGEM_OPCOES: ReadonlyArray<{ value: VinculoFiltroOrigem; label: string }> = [
  { value: "todos", label: "Todas as origens" },
  { value: "lia", label: "Lia" },
  { value: "humano", label: "Humano" },
];

/**
 * Conta quantos filtros estao fora do estado inicial (para exibir
 * o contador discreto ao lado do botao "Limpar filtros").
 */
export function contarFiltrosAtivos(value: VinculoFiltrosValue): number {
  let n = 0;
  if (value.status !== VINCULO_FILTROS_INICIAL.status) n += 1;
  if (value.origem !== VINCULO_FILTROS_INICIAL.origem) n += 1;
  if (value.contador_uso_min.trim() !== "") n += 1;
  if (value.contador_uso_max.trim() !== "") n += 1;
  return n;
}

/**
 * VinculoFiltros - barra de filtros controlada.
 *
 * Props:
 *   - value              estado atual dos filtros
 *   - onChange           callback disparado em qualquer alteracao
 *   - onClear            callback do botao "Limpar filtros"
 *   - disabled           desabilita todos os campos (ex.: durante refetch)
 */
export function VinculoFiltros({
  value,
  onChange,
  onClear,
  disabled = false,
}: {
  value: VinculoFiltrosValue;
  onChange: (next: VinculoFiltrosValue) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const ativos = contarFiltrosAtivos(value);

  function patch(part: Partial<VinculoFiltrosValue>) {
    onChange({ ...value, ...part });
  }

  return (
    <section
      data-card="vinculo-filtros"
      aria-label="Filtros da listagem de vínculos"
      className={cn(
        "flex flex-col gap-3 rounded-md border border-border bg-surface-2/40 p-3",
        "sm:flex-row sm:flex-wrap sm:items-end sm:gap-3",
      )}
    >
      {/* Header da barra (mobile: rotulo + botao; desktop: fica apenas o botao) */}
      <div className="flex items-center gap-2 sm:order-first sm:mr-1 sm:self-center">
        <Filter className="size-3.5 text-muted" aria-hidden="true" />
        <span className="text-[12.5px] font-medium text-muted">Filtros</span>
        {ativos > 0 ? (
          <span
            className="rounded-full bg-accent-soft px-1.5 py-px text-[11px] font-semibold text-accent"
            data-badge="filtros-ativos"
          >
            {ativos}
          </span>
        ) : null}
      </div>

      {/* Status ----------------------------------------------------------- */}
      <div className="flex flex-1 flex-col gap-1 sm:min-w-[170px]">
        <label
          htmlFor="vinculo-filtro-status"
          className="text-[12px] font-medium text-muted"
        >
          Status
        </label>
        <Select
          id="vinculo-filtro-status"
          value={value.status}
          onChange={(e) => patch({ status: e.target.value as VinculoFiltroStatus })}
          disabled={disabled}
        >
          {STATUS_OPCOES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>

      {/* Origem ----------------------------------------------------------- */}
      <div className="flex flex-1 flex-col gap-1 sm:min-w-[170px]">
        <label
          htmlFor="vinculo-filtro-origem"
          className="text-[12px] font-medium text-muted"
        >
          Origem
        </label>
        <Select
          id="vinculo-filtro-origem"
          value={value.origem}
          onChange={(e) => patch({ origem: e.target.value as VinculoFiltroOrigem })}
          disabled={disabled}
        >
          {ORIGEM_OPCOES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>

      {/* contador_uso_min ------------------------------------------------- */}
      <div className="flex flex-col gap-1 sm:w-[150px]">
        <label
          htmlFor="vinculo-filtro-uso-min"
          className="text-[12px] font-medium text-muted"
        >
          Uso mínimo
        </label>
        <Input
          id="vinculo-filtro-uso-min"
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          placeholder="ex.: 5"
          value={value.contador_uso_min}
          onChange={(e) => patch({ contador_uso_min: e.target.value })}
          disabled={disabled}
        />
      </div>

      {/* contador_uso_max ------------------------------------------------- */}
      <div className="flex flex-col gap-1 sm:w-[150px]">
        <label
          htmlFor="vinculo-filtro-uso-max"
          className="text-[12px] font-medium text-muted"
        >
          Uso máximo
        </label>
        <Input
          id="vinculo-filtro-uso-max"
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          placeholder="ex.: 100"
          value={value.contador_uso_max}
          onChange={(e) => patch({ contador_uso_max: e.target.value })}
          disabled={disabled}
        />
      </div>

      {/* Botao limpar (sempre visivel para nao esconder o caminho de reset) */}
      <div className="flex flex-col gap-1 sm:flex-none">
        <span className="hidden text-[12px] font-medium text-transparent sm:block">
          .
        </span>
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={onClear}
          disabled={disabled || ativos === 0}
          data-btn="limpar-filtros-vinculo"
          aria-label="Limpar filtros de vínculos"
          className="w-full sm:w-auto"
        >
          <Eraser aria-hidden="true" />
          <span>Limpar filtros</span>
        </Button>
      </div>
    </section>
  );
}