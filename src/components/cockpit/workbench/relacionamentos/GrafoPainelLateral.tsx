"use client";

// =====================================================================
// GrafoPainelLateral - painel lateral exibido quando um no do grafo e
// selecionado. Mostra o no-ancora no topo e a lista de vizinhos agrupada
// por profundidade. Cada vizinho e clicavel: ao clicar, dispara nova
// chamada a vizinhanca com o vizinho como nova ancora.
//
// Estado vazio: mostra instrucao "Selecione um no no grafo".
// =====================================================================

import { useMemo } from "react";
import { Circle, Layers, Network, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NoVisual, VizinhoVisual } from "@/lib/api/relacionamentos-types";
import { Pill } from "@/components/ui/pill";

// ---------------------------------------------------------------------
// Tipos.
// ---------------------------------------------------------------------

export interface GrafoPainelLateralProps {
  noSelecionado: NoVisual | null;
  vizinhos: VizinhoVisual[];
  isLoading: boolean;
  onSelectNeighbor: (vizinho: VizinhoVisual) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------
// Sub-componentes.
// ---------------------------------------------------------------------

function IconeTipo({ tipo }: { tipo: NoVisual["tipo"] }) {
  // Resolucao simples do icone pelo tipo. Mantem o componente estavel para
  // evitar flashes de re-render. Usamos Lucide `Network` como fallback.
  switch (tipo) {
    case "aviso":
      return <Circle className="size-3.5" aria-hidden="true" />;
    case "documento":
      return <Layers className="size-3.5" aria-hidden="true" />;
    case "pessoa":
      return <Circle className="size-3.5" aria-hidden="true" />;
    default:
      return <Network className="size-3.5" aria-hidden="true" />;
  }
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function GrafoPainelLateral({
  noSelecionado,
  vizinhos,
  isLoading,
  onSelectNeighbor,
  onClose,
}: GrafoPainelLateralProps) {
  // Agrupa vizinhos por profundidade (1-hop, 2-hop, ...).
  const vizinhosPorProfundidade = useMemo(() => {
    const map = new Map<number, VizinhoVisual[]>();
    for (const v of vizinhos) {
      const arr = map.get(v.profundidade) ?? [];
      arr.push(v);
      map.set(v.profundidade, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [vizinhos]);

  return (
    <aside
      data-painel-lateral-grafo
      aria-label="Detalhes do no selecionado"
      className={cn(
        "flex h-full flex-col gap-3 overflow-hidden",
        "border-l border-border bg-surface-2/40",
      )}
    >
      {/* Header fixo com ancora + botao fechar */}
      <header className="flex items-start justify-between gap-2 border-b border-border p-4">
        <div className="min-w-0 flex-1">
          {noSelecionado ? (
            <>
              <div className="flex items-center gap-2">
                <span
                  className="inline-block size-3 flex-none rounded-full"
                  style={{ background: noSelecionado.cor }}
                  aria-hidden="true"
                />
                <Pill variant="neutral" className="!text-[10px]">
                  {noSelecionado.tipo}
                </Pill>
              </div>
              <h3 className="mt-1.5 truncate text-[14px] font-semibold text-fg">
                {noSelecionado.label}
              </h3>
            </>
          ) : (
            <p className="text-[12.5px] text-muted">Nenhum no selecionado</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar painel de detalhes"
          className={cn(
            "grid size-7 flex-none place-items-center rounded-sm text-muted",
            "transition-colors hover:bg-surface-3 hover:text-fg",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
          )}
        >
          <X className="size-[15px]" aria-hidden="true" />
        </button>
      </header>

      {/* Corpo: lista de vizinhos por profundidade ou empty state */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!noSelecionado ? (
          <div
            data-empty="painel-lateral-grafo"
            className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border bg-surface/40 p-6 text-center text-muted"
          >
            <Network className="size-6" aria-hidden="true" />
            <p className="text-[13px] font-semibold text-fg">
              Selecione um no no grafo
            </p>
            <p className="text-[12px] text-muted">
              Clique em qualquer no para ver seus vizinhos.
            </p>
          </div>
        ) : isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={`skel-${i}`}
                className="h-9 animate-pulse rounded-sm bg-surface-3"
              />
            ))}
          </div>
        ) : vizinhosPorProfundidade.length === 0 ? (
          <p className="text-[12.5px] text-muted">
            Nenhum vizinho encontrado para este no.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {vizinhosPorProfundidade.map(([prof, lista]) => (
              <section key={prof} data-profundidade={prof}>
                <header className="mb-1.5 flex items-center gap-2">
                  <h4 className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">
                    {prof === 1 ? "1-hop" : prof === 2 ? "2-hop" : `${prof}-hop`}
                  </h4>
                  <span className="text-[11px] text-faint">
                    {lista.length}
                  </span>
                </header>
                <ul className="flex flex-col gap-1">
                  {lista.map((v) => (
                    <li key={`${v.tipo}:${v.id}`}>
                      <button
                        type="button"
                        onClick={() => onSelectNeighbor(v)}
                        aria-label={`Selecionar vizinho ${v.label}`}
                        data-vizinho={v.id}
                        data-vizinho-tipo={v.tipo}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-sm border border-transparent px-2 py-1.5",
                          "text-left text-[12.5px] text-fg",
                          "transition-colors hover:border-border hover:bg-surface-3",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
                        )}
                      >
                        <span
                          className="size-2.5 flex-none rounded-full"
                          style={{ background: v.cor }}
                          aria-hidden="true"
                        />
                        <IconeTipo tipo={v.tipo} />
                        <span className="min-w-0 flex-1 truncate">{v.label}</span>
                        <span className="flex-none text-[11px] text-faint">
                          {v.tipo}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}