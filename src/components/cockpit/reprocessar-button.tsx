"use client";

import { useState } from "react";
import { RefreshCw, Loader2, Check, TriangleAlert } from "lucide-react";
import { useReprocessar } from "@/hooks/use-substrato";
import { ApiError } from "@/lib/api/client";

type Feedback = { kind: "ok" | "info" | "err"; message: string };

/**
 * action-reprocessar — Reprocessa a indexacao de um unico item
 * (POST /substrato/avisos/:id/reindexar).
 *
 * Bloqueio durante o reprocesso (anti-duplo-disparo): o botao fica desabilitado
 * enquanto a mutation esta pendente; se o backend responder { status:
 * 'em_andamento' } (ja havia reprocesso para o item) ou um 409, refletimos o
 * estado sem permitir novo disparo. Em sucesso o detalhe do edital e a lista de
 * erros sao invalidados pelo hook, atualizando o pipeline.
 */
export function ReprocessarButton({ avisoId }: { avisoId: string }) {
  const mutation = useReprocessar(avisoId);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [running, setRunning] = useState(false);

  const disabled = mutation.isPending || running;

  async function handleClick() {
    if (disabled) return;
    setFeedback(null);
    try {
      const res = await mutation.mutateAsync();
      if (res.status === "em_andamento") {
        // Ja existe um reprocesso em andamento para este item.
        setRunning(true);
        setFeedback({
          kind: "info",
          message: "Reprocesso já em andamento para este item; aguarde a conclusão.",
        });
        return;
      }
      setFeedback({ kind: "ok", message: "Reindexação concluída · índice atualizado." });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? "Já existe um reprocesso em andamento; aguarde a conclusão."
          : "Não foi possível reprocessar o item. Verifique os erros de ingestão.";
      setFeedback({ kind: err instanceof ApiError && err.status === 409 ? "info" : "err", message });
      if (err instanceof ApiError && err.status === 409) setRunning(true);
    }
  }

  const pending = mutation.isPending;

  return (
    <div className="action-col" style={{ alignItems: "flex-start", marginTop: 16 }}>
      <button
        type="button"
        className="btn btn-sm"
        onClick={handleClick}
        disabled={disabled}
        aria-disabled={disabled}
        title={running ? "Reprocesso em andamento" : undefined}
      >
        {pending || running ? (
          <Loader2 className="spin" aria-hidden="true" />
        ) : (
          <RefreshCw aria-hidden="true" />
        )}
        {pending ? "Reprocessando…" : running ? "Em andamento" : "Reprocessar indexação"}
      </button>

      {feedback ? (
        <span
          className="action-hint"
          role="status"
          style={{
            color:
              feedback.kind === "err"
                ? "var(--err)"
                : feedback.kind === "ok"
                  ? "var(--ok)"
                  : "var(--run)",
          }}
        >
          {feedback.kind === "err" ? (
            <TriangleAlert aria-hidden="true" />
          ) : feedback.kind === "ok" ? (
            <Check aria-hidden="true" />
          ) : (
            <Loader2 className="spin" aria-hidden="true" />
          )}
          {feedback.message}
        </span>
      ) : null}
    </div>
  );
}
