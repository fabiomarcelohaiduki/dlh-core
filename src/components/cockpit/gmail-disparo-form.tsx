"use client";

import { useState } from "react";
import { Check, Loader2, Play, TriangleAlert } from "lucide-react";
import { useDispararGmail } from "@/hooks/use-admin";
import { useExecucoes } from "@/hooks/use-monitoring";
import { hasRunningExecucao } from "@/lib/status";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-gmail-disparo-form — Disparo MANUAL da coleta do Gmail.
 *
 * O Gmail coleta num runner Node do GitHub Actions (a credencial Gmail e a API
 * do Google so existem la). Este botao aciona o workflow proprio coletar-gmail.yml:
 * o runner monta a query pela config do cockpit (data inicial + categorias +
 * labels excluidas), descobre as mensagens e enfileira corpo + anexos. O Drive
 * tem workflow proprio e nao e varrido nesse disparo.
 *
 * A coleta roda assincrona: o disparo so a ENFILEIRA (202); o andamento
 * aparece em Execuções quando o runner registra o inicio.
 */
export function GmailDisparoForm({
  fonteId,
  bare = false,
}: {
  fonteId: string | null;
  /** Renderiza sem o card proprio (para embutir num card externo). */
  bare?: boolean;
}) {
  const disparar = useDispararGmail();
  // Poll a cada 5s para o aviso de coleta em andamento refletir o estado real
  // (a coleta pode iniciar pelo agendamento/runner, sem passar por este botao).
  // O botao NAO trava: o 409 do Edge e a defesa contra duplo-disparo.
  const execucoes = useExecucoes({ limit: 50, refetchInterval: 5000 });
  const running = hasRunningExecucao(execucoes.data?.items, fonteId);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function executar() {
    setFeedback(null);
    try {
      await disparar.mutateAsync();
      setFeedback({ kind: "ok", message: "Coleta disparada · acompanhe em Execuções." });
    } catch (err) {
      let message = "Falha ao disparar a coleta. Tente novamente.";
      if (err instanceof ApiError && err.status === 409) {
        message = "Já há uma coleta do Gmail em andamento; aguarde a conclusão.";
      } else if (err instanceof ApiError && err.status === 502) {
        message = "Não foi possível acionar o coletor na nuvem. Tente novamente.";
      }
      setFeedback({ kind: "err", message });
    }
  }

  const ocupado = disparar.isPending;

  const body = (
    <div className="form-foot" style={{ marginTop: 0, flexWrap: "wrap" }}>
      <button className="btn btn-primary" type="button" onClick={executar} disabled={ocupado}>
        {ocupado ? (
          <Loader2 className="spin" aria-hidden="true" />
        ) : (
          <Play aria-hidden="true" />
        )}
        <span>{ocupado ? "Disparando…" : "Coletar e-mails agora"}</span>
      </button>

      {running ? (
        <span className="action-hint">
          <Loader2 className="spin" aria-hidden="true" />
          Coleta em andamento; aguarde a conclusão.
        </span>
      ) : feedback ? (
        <span className={cn("save-note", feedback.kind === "err" && "err")}>
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

  return bare ? body : <div className="card form-card">{body}</div>;
}
