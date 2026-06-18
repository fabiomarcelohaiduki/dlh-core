"use client";

import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { FeedbackHumano, Veredito } from "@/lib/api/types";
import { useTriagemFeedback } from "@/hooks/use-triagem-feedback";
import { cn } from "@/lib/utils";

const ROTULOS: { value: Veredito; label: string }[] = [
  { value: "util", label: "Útil" },
  { value: "duvida", label: "Dúvida" },
  { value: "lixo", label: "Lixo" },
];

/**
 * cmp-feedback-buttons — Feedback humano inline (acertou/errou) por linha da
 * triagem. "Acertou" grava feedback `correto`; "Errou" abre a escolha do rotulo
 * correto (util/duvida/lixo) e grava `incorreto` com o rotulo. Loading por linha
 * via Loader2 (spin). Reflete o feedback ja gravado destacando a acao escolhida.
 */
export function FeedbackButtons({
  avisoId,
  veredito,
  feedbackHumano,
  onSuccess,
  onError,
}: {
  avisoId: string;
  veredito: Veredito | null;
  feedbackHumano: FeedbackHumano | null;
  /** Disparado no sucesso (toast + atualizacao otimista na tela). */
  onSuccess?: (feedback: FeedbackHumano) => void;
  onError?: () => void;
}) {
  const feedback = useTriagemFeedback();
  const [choosing, setChoosing] = useState(false);

  const pending = feedback.isPending;
  const pendingKind = pending ? feedback.variables?.feedback : null;

  function acertou() {
    feedback.mutate(
      { avisoId, feedback: "correto" },
      {
        onSuccess: () => {
          setChoosing(false);
          onSuccess?.("correto");
        },
        onError: () => onError?.(),
      },
    );
  }

  function errou(rotuloCorreto: Veredito) {
    feedback.mutate(
      { avisoId, feedback: "incorreto", rotuloCorreto },
      {
        onSuccess: () => {
          setChoosing(false);
          onSuccess?.("incorreto");
        },
        onError: () => onError?.(),
      },
    );
  }

  // "Errou" expande a escolha do rotulo correto; exclui o veredito atual.
  if (choosing) {
    const opcoes = ROTULOS.filter((r) => r.value !== veredito);
    return (
      <div className="action-col" role="group" aria-label="Qual era o veredito correto?">
        <span className="sub">Correto:</span>
        {opcoes.map((r) => (
          <button
            key={r.value}
            type="button"
            className="btn btn-sm"
            disabled={pending}
            onClick={() => errou(r.value)}
          >
            {pending && pendingKind === "incorreto" ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : null}
            {r.label}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-sm"
          disabled={pending}
          aria-label="Cancelar"
          onClick={() => setChoosing(false)}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div className="action-col" role="group" aria-label="Feedback da triagem">
      <button
        type="button"
        className={cn("btn", "btn-sm", feedbackHumano === "correto" && "btn-primary")}
        aria-pressed={feedbackHumano === "correto"}
        disabled={pending}
        onClick={acertou}
      >
        {pending && pendingKind === "correto" ? (
          <Loader2 className="spin" aria-hidden="true" />
        ) : (
          <Check aria-hidden="true" />
        )}
        Acertou
      </button>
      <button
        type="button"
        className={cn("btn", "btn-sm", feedbackHumano === "incorreto" && "btn-primary")}
        aria-pressed={feedbackHumano === "incorreto"}
        disabled={pending}
        onClick={() => setChoosing(true)}
      >
        <X aria-hidden="true" />
        Errou
      </button>
    </div>
  );
}
