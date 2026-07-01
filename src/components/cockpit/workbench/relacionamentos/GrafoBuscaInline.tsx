"use client";

// =====================================================================
// GrafoBuscaInline - input de busca no topo do canvas. Filtra os nos por
// label (case-insensitive, prefix-match). Quando ha match, foca o 1o no
// via CustomEvent (GrafoCanvas ouve 'dlh-grafo-focus'). Esc limpa.
//
// O componente nao conhece vis-network diretamente: dispara um evento
// window custom para manter o acoplamento baixo e permitir testes
// unitarios do handler.
// =====================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NoVisual } from "@/lib/api/relacionamentos-types";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------
// Tipos.
// ---------------------------------------------------------------------

export interface GrafoBuscaInlineProps {
  nos: NoVisual[];
  onClear: () => void;
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function GrafoBuscaInline({ nos, onClear }: GrafoBuscaInlineProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Filtra nos por label (case-insensitive, prefix-match).
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nos.filter((n) => n.label.toLowerCase().includes(q)).slice(0, 12);
  }, [nos, query]);

  // Fecha o dropdown ao clicar fora.
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Esc limpa; Enter foca o 1o match.
  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setQuery("");
      setOpen(false);
      onClear();
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter" && matches.length > 0) {
      const target = matches[Math.min(activeIdx, matches.length - 1)];
      if (target) {
        focusNode(target);
      }
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" && matches.length > 0) {
      setActiveIdx((i) => Math.min(i + 1, matches.length - 1));
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowUp" && matches.length > 0) {
      setActiveIdx((i) => Math.max(i - 1, 0));
      event.preventDefault();
      return;
    }
  }

  function focusNode(no: NoVisual) {
    const visId = `${no.tipo}:${no.id}`;
    window.dispatchEvent(
      new CustomEvent("dlh-grafo-focus", { detail: { visId } }),
    );
    setOpen(false);
    // Limpa o input apos focar (UX de "busca e usa").
    setQuery("");
  }

  return (
    <div
      ref={containerRef}
      data-grafo-busca
      className="relative w-full max-w-md"
    >
      <div className="relative flex items-center">
        <Search
          className="pointer-events-none absolute left-3 size-4 text-muted"
          aria-hidden="true"
        />
        <Input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls="grafo-busca-listbox"
          aria-autocomplete="list"
          placeholder="Buscar no por rotulo..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIdx(0);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          className="!h-9 !pl-9 !pr-9 !text-[12.5px]"
        />
        {query ? (
          <button
            type="button"
            aria-label="Limpar busca"
            onClick={() => {
              setQuery("");
              onClear();
              inputRef.current?.focus();
            }}
            className={cn(
              "absolute right-2 grid size-6 place-items-center rounded-sm text-muted",
              "transition-colors hover:bg-surface-3 hover:text-fg",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
            )}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* Dropdown de sugestoes */}
      {open && matches.length > 0 ? (
        <ul
          id="grafo-busca-listbox"
          role="listbox"
          className={cn(
            "absolute left-0 right-0 top-[calc(100%+4px)] z-20",
            "max-h-72 overflow-y-auto rounded-md border border-border bg-surface",
            "shadow-[var(--shadow-overlay)]",
          )}
        >
          {matches.map((no, idx) => {
            const isActive = idx === activeIdx;
            return (
              <li
                key={`${no.tipo}:${no.id}`}
                role="option"
                aria-selected={isActive}
              >
                <button
                  type="button"
                  onClick={() => focusNode(no)}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-fg",
                    "transition-colors",
                    isActive
                      ? "bg-accent-soft text-accent-strong"
                      : "hover:bg-surface-3",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="size-2.5 flex-none rounded-full"
                    style={{ background: no.cor }}
                  />
                  <span className="min-w-0 flex-1 truncate">{no.label}</span>
                  <span className="flex-none text-[11px] text-faint">
                    {no.tipo}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}