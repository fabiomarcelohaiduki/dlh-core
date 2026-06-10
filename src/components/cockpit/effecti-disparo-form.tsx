"use client";

import { useState } from "react";
import { Check, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useColetaDemanda, useExecucoes } from "@/hooks/use-monitoring";
import { hasRunningExecucao } from "@/lib/status";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-effecti-disparo-form — Disparo MANUAL da coleta do Effecti.
 *
 * Espelha o bloco "Coleta manual" do Nomus para uniformizar os paineis de
 * fonte. O Effecti coleta pelo orquestrador Edge (lock-por-fonte); este botao
 * apenas ENFILEIRA a coleta sob demanda (o andamento aparece em Execucoes).
 * Quando ha alteracoes nao salvas na configuracao (configDirty), avisa que
 * elas NAO valem para esta coleta (so na proxima execucao, apos salvar) antes
 * de disparar. O estado `dirty` vem do CfgForm, subido pelo painel pai.
 */
export function EffectiDisparoForm({
  fonteId,
  configDirty,
}: {
  fonteId: string | null;
  configDirty: boolean;
}) {
  const coleta = useColetaDemanda();
  const execucoes = useExecucoes({ limit: 50 });
  const running = hasRunningExecucao(execucoes.data?.items, fonteId);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const disabled = running || coleta.isPending;

  async function handleColeta() {
    if (disabled) return;
    if (configDirty) {
      const ok = window.confirm(
        "Há alterações não salvas na configuração. Elas NÃO valem para esta coleta " +
          "(somente após salvar, na próxima execução). Deseja disparar a coleta agora mesmo assim?",
      );
      if (!ok) return;
    }
    setFeedback(null);
    try {
      await coleta.mutateAsync(undefined);
      setFeedback({ kind: "ok", message: "Coleta disparada · acompanhe em Execuções." });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? "Já existe uma coleta em andamento; aguarde a conclusão."
          : "Não foi possível disparar a coleta. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  return (
    <div className="card form-card">
        <div className="form-foot" style={{ marginTop: 0, flexWrap: "wrap" }}>
          <button
            className="btn btn-primary"
            type="button"
            onClick={handleColeta}
            disabled={disabled}
            aria-disabled={disabled}
            title={running ? "Coleta em andamento" : undefined}
          >
            {coleta.isPending ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            <span>{coleta.isPending ? "Disparando…" : "Executar coleta agora"}</span>
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

        <div className="helper" style={{ marginTop: 12 }}>
          A coleta usa a janela e os filtros salvos na configuração abaixo.
        </div>
      </div>
  );
}
