"use client";

import { useState } from "react";
import { Check, History, Loader2, Play, TriangleAlert } from "lucide-react";
import { useDispararNomus } from "@/hooks/use-admin";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { NomusModo } from "@/lib/api/types";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-nomus-disparo-form — Disparo MANUAL da coleta do Nomus.
 *
 * O Nomus coleta num runner Node do GitHub Actions (o Edge nao fecha o TLS
 * legado do Nomus). Estes botoes acionam o workflow_dispatch sob demanda:
 *   - "Coletar agora" (incremental): so os processos NOVOS (id acima da marca
 *     d'agua). Rapido, mas NAO reprocessa edicoes de processos ja coletados.
 *   - "Re-varrer janela" (full): re-varre todos os processos da JANELA
 *     configurada e atualiza o que mudou, inclusive edicoes — operacao pesada,
 *     por isso exige confirmacao. E o mesmo modo do agendamento diario (o Nomus
 *     nao expoe data de alteracao, entao so o full captura edicoes).
 *
 * A coleta roda assincrona: o disparo so a ENFILEIRA (202); o andamento
 * aparece no Dashboard/Execucoes quando o runner registra o inicio.
 */
export function NomusDisparoForm({ recurso = "processos" }: { recurso?: string }) {
  const disparar = useDispararNomus();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Modo em voo: trava ambos os botoes e mostra o spinner so no acionado.
  const [emVoo, setEmVoo] = useState<NomusModo | null>(null);
  // Armado o full -> exige um segundo clique para confirmar o backfill.
  const [confirmandoFull, setConfirmandoFull] = useState(false);

  async function executar(modo: NomusModo) {
    setFeedback(null);
    setEmVoo(modo);
    try {
      await disparar.mutateAsync({ modo, recurso });
      setFeedback({
        kind: "ok",
        message:
          modo === "full"
            ? "Re-varredura disparada · acompanhe em Execuções."
            : "Coleta disparada · acompanhe em Execuções.",
      });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 502
          ? "Não foi possível acionar o coletor na nuvem. Tente novamente."
          : "Falha ao disparar a coleta. Tente novamente.";
      setFeedback({ kind: "err", message });
    } finally {
      setEmVoo(null);
      setConfirmandoFull(false);
    }
  }

  const ocupado = emVoo !== null;

  return (
    <>
      <div className="card form-card">
        <div className="form-foot" style={{ marginTop: 0, flexWrap: "wrap" }}>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => executar("incremental")}
            disabled={ocupado}
          >
            {emVoo === "incremental" ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
            <span>{emVoo === "incremental" ? "Disparando…" : "Coletar agora"}</span>
          </button>

          {confirmandoFull ? (
            <>
              <button
                className="btn"
                type="button"
                style={{ color: "var(--err)", borderColor: "var(--err-bg)" }}
                onClick={() => executar("full")}
                disabled={ocupado}
              >
                {emVoo === "full" ? (
                  <Loader2 className="spin" aria-hidden="true" />
                ) : (
                  <History aria-hidden="true" />
                )}
                <span>{emVoo === "full" ? "Disparando…" : "Confirmar re-varredura"}</span>
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => setConfirmandoFull(false)}
                disabled={ocupado}
              >
                Cancelar
              </button>
            </>
          ) : (
            <button
              className="btn"
              type="button"
              onClick={() => {
                setFeedback(null);
                setConfirmandoFull(true);
              }}
              disabled={ocupado}
            >
              <History aria-hidden="true" />
              <span>Re-varrer janela (full)</span>
            </button>
          )}

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
          {confirmandoFull
            ? "Re-varre todos os processos da janela configurada e atualiza o que mudou, inclusive edições (operação longa)."
            : "Traz só os processos novos desde a última coleta; não reprocessa edições (uso normal)."}
        </div>
      </div>
    </>
  );
}
