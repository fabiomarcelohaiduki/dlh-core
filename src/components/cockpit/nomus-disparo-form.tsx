"use client";

import { useState } from "react";
import { Check, History, Loader2, Play, TriangleAlert } from "lucide-react";
import { useDispararNomus } from "@/hooks/use-admin";
import { useExecucoes } from "@/hooks/use-monitoring";
import { hasRunningExecucao } from "@/lib/status";
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
export function NomusDisparoForm({
  recurso = "processos",
  janelaDias = null,
  fonteId = null,
}: {
  recurso?: string;
  janelaDias?: number | null;
  fonteId?: string | null;
}) {
  const janelaLabel = janelaDias != null ? `${janelaDias} dias` : "full";
  const janelaFrase =
    janelaDias != null ? `dos últimos ${janelaDias} dias` : "da janela configurada";
  const disparar = useDispararNomus();
  // Poll a cada 5s enquanto o painel esta aberto: a coleta roda assincrona no
  // runner (e pode iniciar pelo agendamento), entao o bloqueio precisa detectar
  // o estado em tempo (quase) real, nao so no 1o fetch.
  const execucoes = useExecucoes({ limit: 50, refetchInterval: 5000 });
  // Trava os botoes enquanto ja ha coleta desta fonte rodando (evita queimar um
  // run do Actions que so falharia com 409 no primeiro push). Alinha o Nomus
  // ao comportamento do Effecti; o 409 do Edge segue como rede de seguranca.
  const running = hasRunningExecucao(execucoes.data?.items, fonteId);
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
      let message = "Falha ao disparar a coleta. Tente novamente.";
      if (err instanceof ApiError && err.status === 409) {
        message = "Já há uma coleta do Nomus em andamento; aguarde concluir.";
      } else if (err instanceof ApiError && err.status === 502) {
        message = "Não foi possível acionar o coletor na nuvem. Tente novamente.";
      }
      setFeedback({ kind: "err", message });
    } finally {
      setEmVoo(null);
      setConfirmandoFull(false);
    }
  }

  const ocupado = emVoo !== null || running;

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
            <span>{emVoo === "incremental" ? "Disparando…" : "Coletar novos agora"}</span>
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
              <span>Re-varrer janela ({janelaLabel})</span>
            </button>
          )}

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

        {confirmandoFull && (
          <div className="helper" style={{ marginTop: 12 }}>
            {`Re-varre todos os processos ${janelaFrase} e atualiza o que mudou, inclusive edições (operação longa).`}
          </div>
        )}
      </div>
    </>
  );
}
