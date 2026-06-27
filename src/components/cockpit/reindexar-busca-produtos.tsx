"use client";

import { useState } from "react";
import { Check, Database, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useLinhas } from "@/hooks/use-linhas";
import { reindexarProdutos } from "@/lib/api/produtos";
import { ApiError } from "@/lib/api/client";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-reindexar-busca-produtos — botao "Reindexar busca de produtos" nas
 * Configuracoes do modulo Cadastros. Recalcula o vocabulario de busca
 * (embeddings) de TODOS os SKUs ativos apos alterar termos/atributos.
 *
 * Reindexa linha a linha (cada chamada escopada por linha_id) em serie. Isso
 * evita o timeout do gateway (varrer os ~246 SKUs num unico request com embed
 * serial estoura os 150s) e da progresso visivel (N de N linhas). Acumula o
 * total de SKUs reindexados; se uma linha falha, segue as demais e reporta.
 */
export function ReindexarBuscaProdutos() {
  const { data, isLoading, isError } = useLinhas({ ativo: true, limit: 200 });
  const linhas = data?.items ?? [];

  const [rodando, setRodando] = useState(false);
  const [progresso, setProgresso] = useState<{ feita: number; total: number } | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function onReindexar() {
    if (rodando || linhas.length === 0) return;
    setFeedback(null);
    setProgresso({ feita: 0, total: linhas.length });
    setRodando(true);

    let indexados = 0;
    let linhasComErro = 0;
    let erro503 = false;

    for (let i = 0; i < linhas.length; i++) {
      try {
        const r = await reindexarProdutos(linhas[i].id);
        indexados += r.indexados;
      } catch (err) {
        linhasComErro += 1;
        if (err instanceof ApiError && err.status === 503) erro503 = true;
      } finally {
        setProgresso({ feita: i + 1, total: linhas.length });
      }
    }

    setRodando(false);
    setProgresso(null);
    if (linhasComErro === 0) {
      setFeedback({
        kind: "ok",
        message: `Índice atualizado · ${indexados} SKU(s) reindexado(s) em ${linhas.length} linha(s).`,
      });
    } else if (erro503) {
      setFeedback({
        kind: "err",
        message: "Reindexação indisponível: configure e ative a IA em Integrações.",
      });
    } else {
      setFeedback({
        kind: "err",
        message: `${linhasComErro} linha(s) falharam · ${indexados} SKU(s) reindexado(s). Tente novamente.`,
      });
    }
  }

  return (
    <div className="card form-card form-card--wide">
      <div className="section-title">
        <h3>
          <Database aria-hidden="true" />
          Busca de produtos
        </h3>
      </div>
      <p className="helper" style={{ marginTop: 2, marginBottom: 14 }}>
        Recalcula o vocabulário de busca semântica de todos os SKUs ativos.
        Necessário após alterar termos ou atributos de produtos. A reindexação
        roda linha a linha e pode levar alguns minutos.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onReindexar}
          disabled={rodando || isLoading || isError || linhas.length === 0}
        >
          {rodando ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          <span>{rodando ? "Reindexando…" : "Reindexar busca de produtos"}</span>
        </button>

        {rodando && progresso && (
          <span className="helper">
            {progresso.feita} de {progresso.total} linha(s)
          </span>
        )}

        {isError && (
          <span className="save-note err">
            <TriangleAlert aria-hidden="true" />
            Não foi possível carregar as linhas.
          </span>
        )}

        {!rodando && feedback && (
          <span className={feedback.kind === "err" ? "save-note err" : "save-note"}>
            {feedback.kind === "err" ? (
              <TriangleAlert aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {feedback.message}
          </span>
        )}
      </div>
    </div>
  );
}
