"use client";

// =====================================================================
// GrafoToolbar - barra de acoes do grafo. Botoes:
//   1) Toggle Hierarquico/Semantico - alterna qual dos dois grafos (V2)
//                            e carregado (param `tipo` do panorama).
//   2) Refresh              - recarrega panorama + vizinhanca
//   3) Reprocessar          - dispara useReprocessarRelacionamentos
//   4) Simular 10k          - toggle GATED por NEXT_PUBLIC_RELACIONAMENTOS_DEV_10K
//                            Em prod (flag ausente/false), nem entra no DOM.
//
// Comportamentos:
//   - Reprocessar desabilitado durante execucao (isPending) com label
//     "Executando... (iniciado ha Xs)" usando elapsed counter.
//   - Apos conclusao, resumo inline: "arestas_criadas: N, duracao: Xs"
//     (toast secundario emitido pelo pai via onReprocessado).
// =====================================================================

import { useEffect, useState } from "react";
import { FlaskConical, Network, PlayCircle, RefreshCcw, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api/client";
import type {
  BackfillResultado,
  RelacionamentoTipoGrafo,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Tipos.
// ---------------------------------------------------------------------

export interface GrafoToolbarProps {
  isFetching: boolean;
  isReprocessing: boolean;
  /** Inicio do processamento atual (ms epoch) - usado pelo contador. */
  reprocessStartedAt: number | null;
  /** Resultado do ultimo reprocessamento bem-sucedido. */
  ultimoResultado: BackfillResultado | null;
  /** Grafo carregado atualmente (hierarquico | semantico). */
  tipo: RelacionamentoTipoGrafo;
  /** Alterna o grafo carregado (param `tipo` do panorama). */
  onTipoChange: (tipo: RelacionamentoTipoGrafo) => void;
  onRefresh: () => void;
  onReprocessar: () => void;
  onSimular10kChange: (value: boolean) => void;
  simular10k: boolean;
}

// Segmentos do toggle Hierarquico/Semantico (V2).
const TIPO_SEGMENTOS: ReadonlyArray<{
  value: RelacionamentoTipoGrafo;
  label: string;
  Icon: typeof Network;
  hint: string;
}> = [
  {
    value: "hierarquico",
    label: "Hierárquico",
    Icon: Network,
    hint: "Grafo estrutural (relações de composição e hierarquia)",
  },
  {
    value: "semantico",
    label: "Semântico",
    Icon: Share2,
    hint: "Grafo inferido (relações semânticas descobertas)",
  },
];

// Feature flag de DEV (variavel publica NEXT_PUBLIC_*).
const FEATURE_10K = process.env.NEXT_PUBLIC_RELACIONAMENTOS_DEV_10K === "true";

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${rem.toString().padStart(2, "0")}s`;
}

function humanizarErro(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return "Ja existe um reprocessamento em andamento. Aguarde a conclusao.";
    }
    if (err.status === 401 || err.status === 403) {
      return "Sessao expirada. Faca login novamente.";
    }
    return err.message || "Falha ao reprocessar.";
  }
  return "Falha ao reprocessar.";
}

export { humanizarErro as humanizarErroGrafo };

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function GrafoToolbar({
  isFetching,
  isReprocessing,
  reprocessStartedAt,
  ultimoResultado,
  tipo,
  onTipoChange,
  onRefresh,
  onReprocessar,
  onSimular10kChange,
  simular10k,
}: GrafoToolbarProps) {
  // Contador reativo de elapsed durante execucao.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!isReprocessing || reprocessStartedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [isReprocessing, reprocessStartedAt]);

  const elapsedMs =
    isReprocessing && reprocessStartedAt !== null
      ? Math.max(0, now - reprocessStartedAt)
      : 0;

  return (
    <div
      data-grafo-toolbar
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        "rounded-md border border-border bg-surface-2/40 px-3 py-2",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Toggle Hierarquico/Semantico (V2) - alterna o grafo carregado. */}
        <div
          role="radiogroup"
          aria-label="Tipo de grafo (Hierárquico ou Semântico)"
          data-grafo-tipo-toggle
          data-grafo-tipo={tipo}
          className={cn(
            "inline-flex items-center gap-0.5 rounded-md border border-border bg-surface-3/60 p-0.5",
          )}
        >
          {TIPO_SEGMENTOS.map(({ value, label, Icon, hint }) => {
            const active = tipo === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onTipoChange(value)}
                disabled={isFetching || isReprocessing}
                title={hint}
                data-btn={`grafo-tipo-${value}`}
                data-btn-state={active ? "on" : "off"}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] font-semibold transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  active
                    ? "bg-accent text-accent-fg shadow-[var(--shadow-tooltip)]"
                    : "text-muted hover:text-fg",
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        {/* Refresh */}
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={onRefresh}
          disabled={isFetching || isReprocessing}
          aria-label="Recarregar panorama do grafo"
          data-btn="grafo-refresh"
        >
          <RefreshCcw
            aria-hidden="true"
            className={cn(isFetching && "animate-spin")}
          />
          <span>Recarregar</span>
        </Button>

        {/* Reprocessar */}
        <Button
          type="button"
          size="sm"
          variant="primary"
          onClick={onReprocessar}
          disabled={isReprocessing}
          aria-label="Reprocessar relacionamentos"
          data-btn="grafo-reprocessar"
        >
          <PlayCircle aria-hidden="true" />
          <span>
            {isReprocessing
              ? `Executando... (iniciado há ${formatElapsed(elapsedMs)})`
              : "Reprocessar"}
          </span>
        </Button>

        {/* Resumo do ultimo resultado (inline, nao-toast) */}
        {!isReprocessing && ultimoResultado ? (
          <span
            data-grafo-ultimo-resultado
            className="text-[11.5px] text-muted"
            aria-live="polite"
          >
            Último: <strong className="text-fg">{ultimoResultado.arestas_criadas}</strong>{" "}
            arestas criadas · {formatElapsed(ultimoResultado.duracao_ms)}
          </span>
        ) : null}
      </div>

      {/* Toggle "Simular 10k" - GATED por env var. Em prod nem entra no DOM. */}
      {FEATURE_10K ? (
        <div className="flex items-center gap-2">
          <FlaskConical className="size-3.5 text-muted" aria-hidden="true" />
          <Toggle
            checked={simular10k}
            onChange={(v) => onSimular10kChange(v)}
            ariaLabel="Simular grafo com 10k nos para teste de performance"
          />
          <span className="text-[11.5px] font-medium text-muted">
            Simular 10k (DEV)
          </span>
        </div>
      ) : null}
    </div>
  );
}