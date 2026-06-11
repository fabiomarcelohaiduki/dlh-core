"use client";

import { useState, type CSSProperties } from "react";
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
  janelaDias = null,
  bare = false,
}: {
  fonteId: string | null;
  configDirty: boolean;
  /** Janela deslizante (dias) da config, para a legenda sob o botao. */
  janelaDias?: number | null;
  /** Renderiza sem o card proprio (para embutir num card externo). */
  bare?: boolean;
}) {
  // Legenda fixa sob o botao. O Effecti coleta em BLOCOS com cursor de retomada
  // DENTRO de cada coleta (desde 11/06), mas sem marca d'agua incremental: toda
  // coleta RE-VARRE a janela configurada e deduplica por hash (sem distincao
  // incremental/full do Nomus). Sem janela carregada, frase generica.
  const janelaFrase =
    janelaDias != null ? `os últimos ${janelaDias} dias` : "a janela configurada";
  const caption = `Re-varre ${janelaFrase} e ingere avisos novos; atualiza os que mudaram.`;
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

  // Mesmo formato do helper de campo (.field .helper): texto pequeno, esmaecido.
  // Replicado inline porque a legenda nao vive dentro de um .field (espelha o
  // cmp-nomus-disparo-form).
  const capStyle: CSSProperties = {
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--faint)",
    maxWidth: 240,
  };

  const body = (
    <div
      className="form-foot"
      style={{ marginTop: 0, flexWrap: "wrap", alignItems: "flex-start" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
        <span className="helper" style={capStyle}>{caption}</span>
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
  );

  return bare ? body : <div className="card form-card">{body}</div>;
}
