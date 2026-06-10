"use client";

import { useState } from "react";
import { Check, FileText, Loader2, TriangleAlert } from "lucide-react";
import { useDispararExtracao } from "@/hooks/use-admin";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-extracao-disparo-form — Disparo MANUAL da extracao (camada 1).
 *
 * O extrator e GLOBAL: drena a fila inteira de anexos pendentes (todas as
 * fontes) via Tika. Este botao aciona o workflow extrair-anexos.yml na hora,
 * sem esperar o relogio do agendamento automatico (logo acima). Assincrono no
 * runner do GitHub Actions; o progresso aparece no painel de Extracao.
 *
 * Defesa contra duplo-disparo = 409 do Edge extracao-disparar (concurrency
 * group + GitHub API). A extracao nao grava linha em execucoes.
 */
export function ExtracaoDisparoForm() {
  const disparar = useDispararExtracao();
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function executar() {
    setFeedback(null);
    try {
      await disparar.mutateAsync();
      setFeedback({ kind: "ok", message: "Extração disparada · processa a fila de anexos (Tika)." });
    } catch (err) {
      let message = "Não foi possível disparar a extração. Tente novamente.";
      if (err instanceof ApiError && err.status === 409) {
        message = "Já há uma extração em andamento; aguarde a conclusão.";
      } else if (err instanceof ApiError && err.status === 502) {
        message = "Não foi possível acionar a extração na nuvem. Tente novamente.";
      }
      setFeedback({ kind: "err", message });
    }
  }

  const ocupado = disparar.isPending;

  return (
    <div className="card form-card">
      <div className="form-foot" style={{ marginTop: 0, flexWrap: "wrap" }}>
        <button className="btn btn-primary" type="button" onClick={executar} disabled={ocupado}>
          {ocupado ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <FileText aria-hidden="true" />
          )}
          <span>{ocupado ? "Disparando…" : "Extrair fila agora"}</span>
        </button>

        {feedback ? (
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

      <div className="helper" style={{ marginTop: 10 }}>
        Processa agora os anexos pendentes de todas as fontes via Tika, sem esperar o agendamento
        automático.
      </div>
    </div>
  );
}
