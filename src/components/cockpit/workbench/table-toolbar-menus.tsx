"use client";

// =====================================================================
// table-toolbar-menus — controles icon-only da toolbar da tabela.
//
//   - ColumnToggleMenu (icone sliders): mostra/oculta colunas da tabela.
//   - FieldFilterMenu  (icone funil):   filtra por valor em qualquer campo.
//
// Ambos sao popovers ancorados ao botao, fechados por clique-fora e Escape
// (mesmo idioma do cluster de acoes da topbar). Um ponto de acento no canto
// do botao sinaliza quando ha colunas ocultas / filtros ativos.
// =====================================================================

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Filter, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TableColumnMeta } from "./table-column";

const TRIGGER_CLASS = "h-[42px] w-[42px] rounded-[12px]";

// Classe da busca da toolbar, alinhada aos botoes de menu (altura 42px, raio
// 12px, fundo color-mix fg 5%). Compartilhada por todas as views de tabela
// para manter a barra de ferramentas identica entre elas.
export const TOOLBAR_SEARCH_CLASS =
  "h-[42px] min-w-[220px] flex-1 rounded-[12px] border border-border bg-[color-mix(in_oklch,var(--fg)_5%,transparent)] px-3 text-[13.5px] text-fg placeholder:text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line";
const PANEL_CLASS =
  "absolute right-0 top-[calc(100%+6px)] z-30 max-h-[min(70vh,480px)] w-[260px] overflow-y-auto rounded-md border border-border bg-surface p-2 shadow-[var(--shadow-overlay)]";

/** Popover icon-only com clique-fora/Escape; expoe `close` ao conteudo. */
function IconPopover({
  icon,
  label,
  active,
  children,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        variant="icon"
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={TRIGGER_CLASS}
      >
        {icon}
      </Button>
      {active ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-1 top-1 size-2 rounded-full bg-accent ring-2 ring-surface-2"
        />
      ) : null}
      {open ? (
        <div role="menu" className={PANEL_CLASS}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

/** Menu de visibilidade de colunas (icone sliders). */
export function ColumnToggleMenu({
  columns,
  hidden,
  onToggle,
  onShowAll,
}: {
  columns: readonly TableColumnMeta[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onShowAll: () => void;
}) {
  return (
    <IconPopover
      icon={<SlidersHorizontal aria-hidden="true" />}
      label="Colunas"
      active={hidden.size > 0}
    >
      {() => (
        <div className="grid gap-0.5">
          <div className="flex items-center justify-between gap-2 px-1.5 py-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-soft">
              Colunas
            </span>
            {hidden.size > 0 ? (
              <button
                type="button"
                className="text-[12px] text-accent-strong hover:underline"
                onClick={onShowAll}
              >
                Mostrar todas
              </button>
            ) : null}
          </div>
          {columns.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-sm px-1.5 py-1.5 text-[13px] text-fg hover:bg-surface-2"
            >
              <input
                type="checkbox"
                checked={!hidden.has(c.id)}
                onChange={() => onToggle(c.id)}
                className="size-3.5 accent-[var(--accent)]"
              />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </IconPopover>
  );
}

/** Menu de filtro por campo (icone funil). Um input de texto por coluna. */
export function FieldFilterMenu({
  columns,
  values,
  onChange,
  onClear,
}: {
  columns: readonly TableColumnMeta[];
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
  onClear: () => void;
}) {
  const activeCount = Object.values(values).filter((v) => v.trim()).length;
  return (
    <IconPopover
      icon={<Filter aria-hidden="true" />}
      label="Filtrar campos"
      active={activeCount > 0}
    >
      {() => (
        <div className="grid gap-2 pb-1">
          <div className="flex items-center justify-between gap-2 px-1.5 pt-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-soft">
              Filtrar campos
            </span>
            {activeCount > 0 ? (
              <button
                type="button"
                className="text-[12px] text-accent-strong hover:underline"
                onClick={onClear}
              >
                Limpar
              </button>
            ) : null}
          </div>
          {columns.map((c) => (
            <label key={c.id} className="grid gap-1 px-1.5">
              <span className="text-[12px] text-muted">{c.label}</span>
              <input
                type="text"
                value={values[c.id] ?? ""}
                onChange={(e) => onChange(c.id, e.target.value)}
                placeholder={`Filtrar ${c.label.toLowerCase()}`}
                className="h-[34px] rounded-sm border border-border bg-[color-mix(in_oklch,var(--fg)_5%,transparent)] px-2.5 text-[13px] text-fg placeholder:text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
              />
            </label>
          ))}
        </div>
      )}
    </IconPopover>
  );
}
