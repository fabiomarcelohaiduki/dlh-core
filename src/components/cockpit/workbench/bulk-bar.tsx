"use client";

// =====================================================================
// BulkBar — barra de selecao em lote (bloco `lote`, banda da tabela).
//
// Reflete a selecao da tabela: contagem visivel de itens marcados e uma acao
// contextual (Reexecutar / Conferir / Arquivar). O botao "Executar" fica
// DESABILITADO com 0 selecionados (EC-12). A acao e read-only (delta-28/29):
// dispara apenas o aviso "Apenas leitura", sem persistir efeito.
// =====================================================================

import { CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Acao contextual do lote (read-only). */
export interface BulkAction {
  id: string;
  label: string;
}

export interface BulkBarProps {
  selectedCount: number;
  actions: readonly BulkAction[];
  actionId: string;
  onActionChange: (id: string) => void;
  /** Executa a acao escolhida (read-only). */
  onExecute: () => void;
  onClear: () => void;
}

export function BulkBar({
  selectedCount,
  actions,
  actionId,
  onActionChange,
  onExecute,
  onClear,
}: BulkBarProps) {
  const hasSelection = selectedCount > 0;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2 px-[18px] py-2.5">
      <span className="inline-flex items-center gap-2 text-[13px] text-fg">
        <CheckSquare aria-hidden="true" className="size-4 text-soft" />
        <span aria-live="polite">
          <strong className="tabular-nums">{selectedCount}</strong>{" "}
          {selectedCount === 1 ? "selecionado" : "selecionados"}
        </span>
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-2.5">
        <label className="sr-only" htmlFor="bulk-action">
          Escolher ação
        </label>
        <select
          id="bulk-action"
          value={actionId}
          disabled={!hasSelection}
          onChange={(e) => onActionChange(e.target.value)}
          className="h-[30px] rounded-sm border border-border bg-surface px-2.5 text-[12.5px] text-fg disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
        >
          {actions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <Button
          variant="default"
          size="sm"
          type="button"
          disabled={!hasSelection}
          onClick={onClear}
        >
          Limpar
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={!hasSelection}
          title="Apenas leitura"
          onClick={onExecute}
        >
          Executar
        </Button>
      </div>
    </div>
  );
}
