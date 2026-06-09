"use client";

import { useState } from "react";
import { Check, Loader2, Play, TriangleAlert } from "lucide-react";
import { useDispararGmail } from "@/hooks/use-admin";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-gmail-disparo-form — Disparo MANUAL da coleta do Gmail.
 *
 * O Gmail coleta num runner Node do GitHub Actions (a credencial Gmail e a API
 * do Google so existem la). Este botao aciona o workflow extrair-anexos.yml com
 * fonte=gmail: o runner monta a query pela config do cockpit (data inicial +
 * labels), descobre as mensagens e enfileira corpo + anexos. O Drive nao e
 * varrido nesse disparo.
 *
 * A coleta roda assincrona: o disparo so a ENFILEIRA (202); o andamento
 * aparece em Execuções quando o runner registra o inicio.
 */
export function GmailDisparoForm() {
  const disparar = useDispararGmail();
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function executar() {
    setFeedback(null);
    try {
      await disparar.mutateAsync();
      setFeedback({ kind: "ok", message: "Coleta disparada · acompanhe em Execuções." });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 502
          ? "Não foi possível acionar o coletor na nuvem. Tente novamente."
          : "Falha ao disparar a coleta. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  const ocupado = disparar.isPending;

  return (
    <>
      <div className="section-title" style={{ margin: "6px 0 13px" }}>
        <div className="titles">
          <h3>Coleta manual</h3>
          <p>
            Dispara a coleta do Gmail agora, sob demanda. A coleta roda na nuvem (runner) e o
            andamento aparece em Execuções.
          </p>
        </div>
      </div>

      <div className="card form-card">
        <div className="form-foot" style={{ marginTop: 0, flexWrap: "wrap" }}>
          <button className="btn btn-primary" type="button" onClick={executar} disabled={ocupado}>
            {ocupado ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
            <span>{ocupado ? "Disparando…" : "Coletar e-mails agora"}</span>
          </button>

          {feedback && (
            <span className={cn("save-note", feedback.kind === "err" && "err")}>
              {feedback.kind === "err" ? (
                <TriangleAlert aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {feedback.message}
            </span>
          )}
        </div>

        <div className="helper" style={{ marginTop: 12 }}>
          Coleta os e-mails da janela definida na configuração (data inicial + labels). Os anexos
          entram na fila de extração junto com o corpo das mensagens.
        </div>
      </div>
    </>
  );
}
