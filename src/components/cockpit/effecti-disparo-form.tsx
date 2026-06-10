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
  bare = false,
}: {
  fonteId: string | null;
  configDirty: boolean;
  /** Renderiza sem o card proprio (para embutir num card externo). */
  bare?: boolean;
}) {
  const coleta = useColetaDemanda();
  // Poll a cada 5s para o aviso de coleta em andamento refletir o estado real
  // (a coleta pode iniciar pelo agendamento/runner, sem passar por este botao).
  // O botao NAO trava: o 409 do Edge e a defesa contra duplo-disparo.
  const execucoes = useExecucoes({ limit: 50, refetchInterval: 5000 });
  const running = hasRunningExecucao(execucoes.data?.items, fonteId);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function handleColeta() {
    if (coleta.isPending) return;
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

  const body = (
    <div className="form-foot" style={{ marginTop: 0, flexWrap: "wrap" }}>
      <button
        className="btn btn-primary"
        type="button"
        onClick={handleColeta}
        disabled={coleta.isPending}
        aria-disabled={coleta.isPending}
      >
        {coleta.isPending ? (
          <Loader2 className="spin" aria-hidden="true" />
        ) : (
          <RefreshCw aria-hidden="true" />
        )}
        <span>{coleta.isPending ? "Disparando…" : "Coletar avisos agora"}</span>
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
