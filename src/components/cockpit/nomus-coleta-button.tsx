"use client";

import { useState } from "react";
import { RefreshCw, Loader2, TriangleAlert, Check } from "lucide-react";
import { useColetar } from "@/hooks/use-fontes";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-nomus-coleta-button — Coleta manual da fonte Nomus (US-04).
 *
 * Dispara POST /ingestao-coletar { fonte:'nomus', recurso:'processos' } via
 * useColetar. No 202 exibe "coleta iniciada"; no 409 (single-flight global)
 * avisa que ja existe uma coleta em andamento. Bloqueia o disparo quando a
 * fonte esta nao_configurada (sem credencial) — orienta cadastrar a chave.
 */
export function NomusColetaButton({
  blocked = false,
  blockedReason,
}: {
  /** Desabilita o disparo (ex.: fonte nao_configurada). */
  blocked?: boolean;
  /** Motivo exibido quando bloqueado (ex.: cadastrar a chave antes). */
  blockedReason?: string;
}) {
  const mutation = useColetar();
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const pending = mutation.isPending;
  const disabled = blocked || pending;

  async function handleClick() {
    if (disabled) return;
    setFeedback(null);
    try {
      await mutation.mutateAsync({ fonte: "nomus", recurso: "processos" });
      setFeedback({ kind: "ok", message: "Coleta iniciada · acompanhe em Execuções" });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? "Já existe uma coleta em andamento; aguarde a conclusão."
          : "Não foi possível disparar a coleta. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  return (
    <div className="action-col">
      <button
        type="button"
        className="btn"
        onClick={handleClick}
        disabled={disabled}
        aria-disabled={disabled}
        title={blocked ? blockedReason : undefined}
      >
        {pending ? (
          <Loader2 className="spin" aria-hidden="true" />
        ) : (
          <RefreshCw aria-hidden="true" />
        )}
        <span>{pending ? "Disparando…" : "Executar coleta agora"}</span>
      </button>

      {blocked ? (
        <span className="action-hint">
          <TriangleAlert aria-hidden="true" />
          {blockedReason ?? "Cadastre e salve a chave antes de coletar."}
        </span>
      ) : feedback ? (
        <span
          className={cn("action-hint")}
          style={{ color: feedback.kind === "err" ? "var(--err)" : "var(--ok)" }}
        >
          {feedback.kind === "err" ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          {feedback.message}
        </span>
      ) : null}
    </div>
  );
}
