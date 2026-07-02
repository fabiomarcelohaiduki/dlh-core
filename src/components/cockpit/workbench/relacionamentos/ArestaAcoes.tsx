"use client";

// =====================================================================
// ArestaAcoes - botoes de acao por linha de aresta na tabela da
// sub-aba Arestas.
//
// Feedback inline (F1) - substitui o antigo workflow de aprovacao:
//   - Eye/EyeOff: marcar/desmarcar "visto" (toggle idempotente).
//   - Flag: sinalizar/reverter "incorreta" (toggle reversivel). Marcar
//     abre um textarea de motivo (aria-required) com botao Confirmar
//     desabilitado enquanto vazio; re-clicar numa aresta ja marcada
//     desmarca e limpa o motivo.
//
// Acoes de navegacao preservadas:
//   - Crosshair: focar o no de origem no grafo (callback onFocus).
//   - Info: placeholder de detalhe (onDetalhes opcional).
//
// Toast de sucesso e optimistic update ficam nos hooks de feedback.
// =====================================================================

import { useState } from "react";
import { Crosshair, Eye, EyeOff, Flag, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useMarcarArestaVista,
  useSinalizarArestaIncorreta,
} from "@/hooks/relacionamentos";
import type { ArestaVisual } from "@/lib/api/relacionamentos-types";

/** Copy fixa auditavel exibida abaixo do campo de motivo. */
const MOTIVO_AVISO = "Este texto fica registrado e auditado. Nao inclua dados sensiveis.";

export interface ArestaAcoesProps {
  /** Aresta alvo do feedback (precisa de `id` para as acoes de feedback). */
  aresta: ArestaVisual;
  onFocus: () => void;
  onDetalhes?: () => void;
  className?: string;
}

const ICON_BTN_BASE = cn(
  "inline-grid size-7 place-items-center rounded-md",
  "border border-transparent text-muted",
  "transition-colors hover:bg-[color-mix(in_oklch,var(--fg)_8%,transparent)] hover:text-fg",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

export function ArestaAcoes({ aresta, onFocus, onDetalhes, className }: ArestaAcoesProps) {
  const arestaId = aresta.id ?? "";
  const temId = arestaId !== "";
  const visto = Boolean(aresta.visto_em);
  const incorreta = Boolean(aresta.incorreta);

  // Estado local do popover de motivo.
  const [motivoAberto, setMotivoAberto] = useState(false);
  const [motivo, setMotivo] = useState("");

  const marcarVista = useMarcarArestaVista(arestaId);
  const sinalizarIncorreta = useSinalizarArestaIncorreta(arestaId, motivo);

  const motivoVazio = motivo.trim() === "";
  const feedbackPendente = marcarVista.isPending || sinalizarIncorreta.isPending;

  function handleVisto() {
    if (!temId) return;
    marcarVista.mutate();
  }

  function handleToggleIncorreta() {
    if (!temId) return;
    if (incorreta) {
      // Re-clique numa aresta ja marcada: desmarca e limpa o motivo.
      setMotivoAberto(false);
      setMotivo("");
      sinalizarIncorreta.mutate();
      return;
    }
    // Ainda nao marcada: abre/fecha o textarea de motivo.
    setMotivoAberto((v) => !v);
  }

  function handleConfirmarIncorreta() {
    if (!temId || motivoVazio) return;
    sinalizarIncorreta.mutate(undefined, {
      onSuccess: () => {
        setMotivoAberto(false);
        setMotivo("");
      },
    });
  }

  return (
    <span className={cn("relative inline-flex items-center gap-1", className)}>
      {/* Focar no grafo */}
      <button
        type="button"
        onClick={onFocus}
        title="Focar no grafo"
        aria-label="Focar no grafo"
        data-btn="aresta-focus"
        className={ICON_BTN_BASE}
      >
        <Crosshair className="size-[14px]" aria-hidden="true" />
      </button>

      {/* Visto (toggle) */}
      <button
        type="button"
        onClick={handleVisto}
        disabled={!temId || feedbackPendente}
        title={visto ? "Desmarcar visto" : "Marcar como visto"}
        aria-label={visto ? "Desmarcar visto" : "Marcar como visto"}
        aria-pressed={visto}
        data-btn="aresta-visto"
        data-btn-state={visto ? "on" : "off"}
        className={cn(
          ICON_BTN_BASE,
          visto &&
            "border-[color:var(--ok)] bg-[color-mix(in_oklch,var(--ok)_16%,transparent)] text-[color:var(--ok)] hover:text-[color:var(--ok)]",
        )}
      >
        {visto ? (
          <Eye className="size-[14px]" aria-hidden="true" />
        ) : (
          <EyeOff className="size-[14px]" aria-hidden="true" />
        )}
      </button>

      {/* Sinalizar incorreta (toggle reversivel) */}
      <button
        type="button"
        onClick={handleToggleIncorreta}
        disabled={!temId || feedbackPendente}
        title={incorreta ? "Reverter sinalizacao de incorreta" : "Sinalizar incorreta"}
        aria-label={incorreta ? "Reverter sinalizacao de incorreta" : "Sinalizar incorreta"}
        aria-pressed={incorreta}
        aria-expanded={motivoAberto}
        data-btn="aresta-incorreta"
        data-btn-state={incorreta ? "on" : "off"}
        className={cn(
          ICON_BTN_BASE,
          incorreta &&
            "border-[color:var(--err)] bg-[color-mix(in_oklch,var(--err)_16%,transparent)] text-[color:var(--err)] hover:text-[color:var(--err)]",
        )}
      >
        <Flag className="size-[14px]" aria-hidden="true" />
      </button>

      {/* Detalhes (placeholder) */}
      <button
        type="button"
        onClick={onDetalhes}
        disabled={!onDetalhes}
        title="Detalhes da aresta"
        aria-label="Detalhes da aresta"
        data-btn="aresta-detalhes"
        className={ICON_BTN_BASE}
      >
        <Info className="size-[14px]" aria-hidden="true" />
      </button>

      {/* Popover de motivo (marcacao de incorreta) */}
      {motivoAberto && !incorreta ? (
        <div
          data-motivo-popover
          className={cn(
            "absolute right-0 top-full z-30 mt-1 w-72",
            "rounded-md border border-border bg-surface-2 p-3 text-left",
            "shadow-[var(--shadow-overlay)]",
          )}
        >
          <label
            htmlFor={`motivo-${arestaId}`}
            className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted"
          >
            Motivo da sinalizacao
          </label>
          <textarea
            id={`motivo-${arestaId}`}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            aria-required="true"
            placeholder="Explique por que esta aresta esta incorreta…"
            className={cn(
              "w-full resize-none rounded-md border border-border bg-bg px-2 py-1.5",
              "text-[12.5px] text-fg outline-none placeholder:text-faint",
              "focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]",
            )}
            data-input-motivo
          />
          <p className="mt-1 text-[11px] text-muted" data-motivo-aviso>
            {MOTIVO_AVISO}
          </p>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setMotivoAberto(false);
                setMotivo("");
              }}
              className="rounded-md px-2 py-1 text-[12px] text-muted hover:text-fg"
              data-btn="aresta-incorreta-cancelar"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleConfirmarIncorreta}
              disabled={motivoVazio || feedbackPendente}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-semibold",
                "bg-[color:var(--err)] text-[color:var(--accent-fg)]",
                "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
              )}
              data-btn="aresta-incorreta-confirmar"
            >
              {sinalizarIncorreta.isPending ? "Confirmando…" : "Confirmar"}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
