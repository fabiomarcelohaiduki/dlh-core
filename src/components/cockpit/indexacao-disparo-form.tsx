"use client";

import { type CSSProperties, useState } from "react";
import { Check, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { useDispararIndexacao, useIndexacaoResumo } from "@/hooks/use-indexacao";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { FonteIndexacao } from "@/lib/api/types";

type Feedback = { kind: "ok" | "err"; message: string };

const COUNTERS: ReadonlyArray<{ key: "pendente" | "emAndamento" | "concluida" | "erro"; label: string }> = [
  { key: "pendente", label: "Pendentes" },
  { key: "emAndamento", label: "Em andamento" },
  { key: "concluida", label: "Indexados" },
  { key: "erro", label: "Erros" },
];

/**
 * cmp-indexacao-disparo-form — Disparo MANUAL do backfill de indexacao + foto
 * da fila ao vivo.
 *
 * O botao aciona 1 lote de backfill (documentos-indexar via reenfileirar_
 * indexacao), que se auto-encadeia pelo banco ate esgotar a fila. So tem efeito
 * quando o master switch (ativo) esta ON; por isso o botao fica travado com
 * aviso quando esta OFF. Confirmacao explicita antes de disparar (acao que
 * gasta na OpenAI — modelo SOM). O resumo abaixo (contagens por status da[s]
 * fonte[s] indexada[s]) faz poll enquanto ha trabalho ativo.
 */
export function IndexacaoDisparoForm({
  fontes,
  ativo,
}: {
  fontes: FonteIndexacao[] | null;
  ativo: boolean;
}) {
  const disparar = useDispararIndexacao();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmar, setConfirmar] = useState(false);

  const resumo = useIndexacaoResumo(fontes, {
    refetchInterval: (query) => {
      const data = query.state.data;
      const ativoTrabalho = data ? data.pendente + data.emAndamento > 0 : false;
      return ativo && ativoTrabalho ? 5000 : false;
    },
  });

  async function executar() {
    setFeedback(null);
    setConfirmar(false);
    try {
      await disparar.mutateAsync();
      setFeedback({ kind: "ok", message: "Backfill disparado · indexando o acervo pendente." });
    } catch (err) {
      let message = "Não foi possível disparar a indexação. Tente novamente.";
      if (err instanceof ApiError && err.status === 502) {
        message = "Não foi possível acionar a indexação na nuvem. Tente novamente.";
      }
      setFeedback({ kind: "err", message });
    }
  }

  const ocupado = disparar.isPending;
  const c = resumo.data;

  const capStyle: CSSProperties = {
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--faint)",
    maxWidth: 260,
  };

  return (
    <div className="card" style={{ display: "grid", gap: 14 }}>
      <div className="cfg-panel-head" style={{ margin: "0 0 2px" }}>
        <div
          className="avatar"
          style={{
            borderRadius: 9,
            width: 34,
            height: 34,
            color: "var(--accent)",
            background: "var(--accent-soft)",
            borderColor: "var(--accent-line)",
          }}
        >
          <Sparkles aria-hidden="true" />
        </div>
        <div style={{ flex: 1 }}>
          <b style={{ fontSize: 14.5 }}>Indexação manual</b>
        </div>
      </div>

      {/* Foto da fila (contagens por status da[s] fonte[s] indexada[s]). */}
      <div className="chk-grid" role="group" aria-label="Resumo da indexação">
        {COUNTERS.map((m) => (
          <div
            key={m.key}
            className="chk"
            style={{ cursor: "default", flexDirection: "column", alignItems: "flex-start", gap: 2 }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>
              {resumo.isLoading ? "—" : (c?.[m.key] ?? 0).toLocaleString("pt-BR")}
            </div>
            <div className="t" style={{ color: "var(--faint)" }}>
              {m.label}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {confirmar ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" type="button" onClick={executar} disabled={ocupado}>
                {ocupado ? (
                  <Loader2 className="spin" aria-hidden="true" />
                ) : (
                  <TriangleAlert aria-hidden="true" />
                )}
                <span>{ocupado ? "Disparando…" : "Confirmar · gera embeddings"}</span>
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => setConfirmar(false)}
                disabled={ocupado}
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => setConfirmar(true)}
              disabled={ocupado || !ativo}
              title={ativo ? undefined : "Ligue a indexação para poder disparar o backfill."}
            >
              <Sparkles aria-hidden="true" />
              <span>Indexar agora</span>
            </button>
          )}
          <span className="helper" style={capStyle}>
            {ativo
              ? "Processa o acervo parado (status pendente) da(s) fonte(s) ligada(s). Custo por token na OpenAI."
              : "Ligue o interruptor da indexação para liberar o disparo."}
          </span>
        </div>

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
    </div>
  );
}
