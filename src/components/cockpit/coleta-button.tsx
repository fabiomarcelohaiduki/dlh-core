"use client";

import { useState } from "react";
import { RefreshCw, Loader2, TriangleAlert, Check } from "lucide-react";
import { useColetaDemanda } from "@/hooks/use-monitoring";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * action-coleta-demanda / action-coleta-demanda-exec — Coleta sob demanda.
 *
 * Reflete o anti-duplo-disparo no front: quando `blocked` (ha execucao
 * em_andamento) o botao fica desabilitado com motivo visivel. O 409
 * `execucao_em_andamento` do backend tambem e tratado como feedback inline.
 */
export function ColetaButton({
  variant = "default",
  label = "Executar coleta agora",
  blocked = false,
  janelaDias,
}: {
  variant?: "primary" | "default";
  label?: string;
  blocked?: boolean;
  janelaDias?: number;
}) {
  const mutation = useColetaDemanda();
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const pending = mutation.isPending;
  const disabled = blocked || pending;

  async function handleClick() {
    if (disabled) return;
    setFeedback(null);
    try {
      await mutation.mutateAsync(janelaDias);
      setFeedback({ kind: "ok", message: "Coleta disparada · acompanhe abaixo" });
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
        className={cn("btn", variant === "primary" && "btn-primary")}
        onClick={handleClick}
        disabled={disabled}
        aria-disabled={disabled}
        title={blocked ? "Coleta em andamento" : undefined}
      >
        {pending ? (
          <Loader2 className="spin" aria-hidden="true" />
        ) : (
          <RefreshCw aria-hidden="true" />
        )}
        <span>{pending ? "Disparando…" : label}</span>
      </button>

      {blocked ? (
        <span className="action-hint">
          <Loader2 className="spin" aria-hidden="true" />
          Coleta em andamento; aguarde a conclusão.
        </span>
      ) : feedback ? (
        <span
          className="action-hint"
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
