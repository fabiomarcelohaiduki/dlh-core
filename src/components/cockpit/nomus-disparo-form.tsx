"use client";

import { useState, type CSSProperties } from "react";
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
 *   - "Coletar novos agora" (incremental): processos -> so os NOVOS (id acima
 *     da marca d'agua), NAO reprocessa edicoes. pessoas -> NOVOS + EDICOES
 *     desde a ultima coleta (o recurso pessoas expoe dataModificacao, entao o
 *     runner faz uma 2a passada por data). Rapido nos dois casos.
 *   - "Re-varrer janela" (full): re-varre TUDO da JANELA configurada e atualiza
 *     o que mudou, inclusive edicoes — operacao pesada, por isso exige
 *     confirmacao. E o mesmo modo do agendamento diario. Para processos e a
 *     UNICA forma de capturar edicoes (o Nomus nao expoe data de alteracao de
 *     processo); para pessoas e so um reforco/recuperacao da janela inteira.
 *
 * A coleta roda assincrona: o disparo so a ENFILEIRA (202); o andamento
 * aparece no Dashboard/Execucoes quando o runner registra o inicio.
 */
export function NomusDisparoForm({
  recurso = "processos",
  janelaDias = null,
  fonteId = null,
  bare = false,
}: {
  recurso?: string;
  janelaDias?: number | null;
  fonteId?: string | null;
  /** Renderiza sem o card proprio (para embutir num card externo). */
  bare?: boolean;
}) {
  // Rotulo do botao full: com janela mostra o recorte; sem janela (ex.: pessoas)
  // nao ha recorte, entao e "Re-varrer tudo (full)".
  const fullLabel =
    janelaDias != null ? `Re-varrer janela (${janelaDias} dias)` : "Re-varrer tudo (full)";
  // Sem janela configurada (janelaDias null), o full varre TODOS os registros
  // — nao ha recorte de janela (caso do recurso pessoas).
  const janelaFrase =
    janelaDias != null ? `os últimos ${janelaDias} dias` : "todos os registros";
  // Legendas fixas sob cada botao. O incremental muda de sentido por recurso:
  // pessoas tem dataModificacao (pega edicoes na 2a passada), processos nao.
  const capIncremental =
    recurso === "pessoas"
      ? "Pessoas novas e edições desde a última coleta. Rápido."
      : "Só processos novos (acima da marca). Não reprocessa edições.";
  const capFull = `Re-varre ${janelaFrase} e atualiza o que mudou, inclusive edições. Operação pesada.`;
  const disparar = useDispararNomus();
  // Poll a cada 5s para o aviso de coleta em andamento refletir o estado real
  // (a coleta pode iniciar pelo agendamento/runner, sem passar por estes botoes).
  // Os botoes NAO travam: o 409 do Edge e a defesa contra duplo-disparo.
  const execucoes = useExecucoes({ limit: 50, refetchInterval: 5000 });
  const running = hasRunningExecucao(execucoes.data?.items, fonteId, recurso);
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

  const ocupado = emVoo !== null;

  // Mesmo formato do helper de campo (.field .helper): texto pequeno, esmaecido.
  // Replicado inline porque a legenda nao vive dentro de um .field.
  const capStyle: CSSProperties = {
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--faint)",
    maxWidth: 240,
  };

  const body = (
    <>
      <div
        className="form-foot"
        style={{ marginTop: 0, flexWrap: "wrap", alignItems: "flex-start" }}
      >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
            <span className="helper" style={capStyle}>{capIncremental}</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {confirmandoFull ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
              </div>
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
                <span>{fullLabel}</span>
              </button>
            )}
            <span className="helper" style={capStyle}>{capFull}</span>
          </div>

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
    </>
  );

  return bare ? body : <div className="card form-card">{body}</div>;
}
