"use client";

import { useState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { useSalvarConfigIndexacao } from "@/hooks/use-indexacao";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ConfigIndexacaoState } from "@/lib/api/types";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-indexacao-agendamento-form — interruptores da indexação (config_indexacao).
 *
 * A indexação NÃO tem horário: é um daemon contínuo (heartbeat cron a cada
 * minuto, gated pelo master switch) + push inline a cada documento novo. Por
 * isso o "agendamento" aqui é só LIGA/DESLIGA — dois interruptores disjuntos:
 *  - documentos: indexa os anexos extraídos das fontes (master switch `ativo`).
 *  - processos: indexa a descrição dos processos do Nomus (`processosAtivo`).
 * Ambos gastam na OpenAI quando ligados. PUT parcial: este form é dono APENAS
 * dessas duas chaves; os parâmetros do motor ficam no drawer Parâmetros da guia
 * Indexação (IndexacaoConfigForm), que manda só as chaves dele.
 */
export function IndexacaoAgendamentoForm({ initial }: { initial: ConfigIndexacaoState }) {
  const salvar = useSalvarConfigIndexacao();
  // Baseline = último estado salvo (não mutamos a prop). O dirty compara o
  // formulário contra ele e o salvar avança o baseline.
  const [salvo, setSalvo] = useState({ ativo: initial.ativo, processosAtivo: initial.processosAtivo });
  const [ativo, setAtivo] = useState(initial.ativo);
  const [processosAtivo, setProcessosAtivo] = useState(initial.processosAtivo);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const isDirty = ativo !== salvo.ativo || processosAtivo !== salvo.processosAtivo;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await salvar.mutateAsync({ ativo, processosAtivo });
      setSalvo({ ativo, processosAtivo });
      setFeedback({ kind: "ok", message: "Interruptores salvos · valem na próxima indexação." });
    } catch (err) {
      const message =
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? "Dados inválidos."
          : "Não foi possível salvar. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="banner">
        <TriangleAlert aria-hidden="true" />
        <div>
          <b>Ligar a indexação gera embeddings na OpenAI (custo por token)</b>
          <p>
            Ligados, novos documentos/processos são indexados no momento da coleta (contínuo) e o
            botão &ldquo;Indexar agora&rdquo; (guia Indexação) processa o acervo parado. Desligados,
            nada é indexado e os textos ficam pendentes. Mantenha desligado até decidir gastar.
          </p>
        </div>
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <label>Indexação · documentos</label>
        <label className={cn("chk", ativo && "on")} style={{ maxWidth: 340 }}>
          <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
          <div className="t">{ativo ? "Ligada (gerando embeddings)" : "Desligada (sem custo)"}</div>
        </label>
        <div className="helper">
          Anexos extraídos das fontes (Effecti, Nomus, Gmail, Drive). Governa o contínuo e o backfill.
        </div>
      </div>

      <div className="field">
        <label>Indexação · processos</label>
        <label className={cn("chk", processosAtivo && "on")} style={{ maxWidth: 340 }}>
          <input
            type="checkbox"
            checked={processosAtivo}
            onChange={(e) => setProcessosAtivo(e.target.checked)}
          />
          <div className="t">
            {processosAtivo ? "Ligada (gerando embeddings)" : "Desligada (sem custo)"}
          </div>
        </label>
        <div className="helper">
          Descrição dos processos do Nomus. Independente do interruptor de documentos; compartilha o
          mesmo orçamento/ritmo definido nos Parâmetros.
        </div>
      </div>

      <div className="form-foot" style={{ marginTop: 18 }}>
        <button className="btn btn-primary" type="submit" disabled={!isDirty || salvar.isPending}>
          {salvar.isPending ? <Loader2 className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
          <span>{salvar.isPending ? "Salvando…" : "Salvar interruptores"}</span>
        </button>
        {feedback && (
          <span className={cn("save-note", feedback.kind === "err" && "err")}>
            {feedback.kind === "err" ? <TriangleAlert aria-hidden="true" /> : <Check aria-hidden="true" />}
            {feedback.message}
          </span>
        )}
      </div>
    </form>
  );
}
