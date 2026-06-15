"use client";

import { type CSSProperties, useState } from "react";
import { Check, Loader2, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import {
  useDispararIndexacao,
  useIndexacaoResumo,
  useReprocessarErrosIndexacao,
} from "@/hooks/use-indexacao";
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
  const reprocessar = useReprocessarErrosIndexacao(fontes);
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

  async function executarReprocesso() {
    setFeedback(null);
    try {
      const { reenfileirados } = await reprocessar.mutateAsync();
      setFeedback({
        kind: "ok",
        message:
          reenfileirados > 0
            ? `${reenfileirados.toLocaleString("pt-BR")} ${reenfileirados === 1 ? "documento reenfileirado" : "documentos reenfileirados"} · de volta na fila.`
            : "Nenhum erro pendente para reprocessar.",
      });
    } catch {
      setFeedback({ kind: "err", message: "Não foi possível reprocessar os erros. Tente novamente." });
    }
  }

  const ocupado = disparar.isPending;
  const reprocessando = reprocessar.isPending;
  const c = resumo.data;

  // Progresso = indexados / total indexavel da(s) fonte(s). Erros contam como
  // ainda nao concluidos (denominador), por isso a barra so chega a 100% quando
  // a fila zera de fato.
  const total = c?.total ?? 0;
  const concluida = c?.concluida ?? 0;
  const erros = c?.erro ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((concluida / total) * 100)) : 0;
  const mostraProgresso = !resumo.isLoading && total > 0;

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

      {/* Barra de progresso: indexados / total indexavel da(s) fonte(s). */}
      {mostraProgresso ? (
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Progresso da indexação"
          style={{ display: "grid", gap: 6 }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              fontSize: 12.5,
              color: "var(--faint)",
            }}
          >
            <span>
              {concluida.toLocaleString("pt-BR")} de {total.toLocaleString("pt-BR")} indexados
            </span>
            <b style={{ fontSize: 13, color: "var(--fg)" }}>{pct}%</b>
          </div>
          <div
            style={{
              height: 8,
              borderRadius: 999,
              background: "var(--surface-2, rgba(127,127,127,.18))",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                borderRadius: 999,
                background: "var(--accent)",
                transition: "width .4s ease",
              }}
            />
          </div>
        </div>
      ) : null}

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

        {erros > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              className="btn"
              type="button"
              onClick={executarReprocesso}
              disabled={reprocessando}
              title="Recoloca na fila os documentos que falharam (erros transitórios da OpenAI)."
            >
              {reprocessando ? (
                <Loader2 className="spin" aria-hidden="true" />
              ) : (
                <RotateCcw aria-hidden="true" />
              )}
              <span>
                {reprocessando
                  ? "Reprocessando…"
                  : `Reprocessar ${erros.toLocaleString("pt-BR")} ${erros === 1 ? "erro" : "erros"}`}
              </span>
            </button>
            <span className="helper" style={capStyle}>
              Erros de indexação são transitórios. Volta os documentos para a fila (reprocesso idempotente).
            </span>
          </div>
        ) : null}

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
