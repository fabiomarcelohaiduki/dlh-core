"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Search, Loader2, TriangleAlert, Database, ChevronRight } from "lucide-react";
import { useBuscaSemantica } from "@/hooks/use-admin";
import { useHealthcheck } from "@/hooks/use-monitoring";

const MIN_TOP_K = 1;
const MAX_TOP_K = 50;
const TOP_K_OPTIONS = [5, 10, 20, 50];

/** Normaliza/limita o topK ao intervalo suportado (espelha normalizeTopK). */
function normalizeTopK(value: number): number {
  return Math.min(Math.max(Math.trunc(value), MIN_TOP_K), MAX_TOP_K);
}

/** Primeira linha util do verbatim, para o titulo do resultado. */
function snippet(verbatim: string, max = 96): string {
  const firstLine = verbatim.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const text = firstLine || verbatim.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || "(sem conteúdo verbatim)";
}

/**
 * cmp-search — Playground de busca semantica (US-18). Validacao humana da API
 * LLM-ready consumida pela Lia.
 *
 * Estados idle/loading/success/empty. action-busca-semantica
 * (useBuscaSemantica -> POST /v1/substrato/busca-semantica). Query vazia e
 * validada aqui e NAO dispara a busca; topK e normalizado no payload.
 *
 * A tela usa a sessao do cockpit (Bearer da sessao Supabase) — NUNCA expoe a
 * API key da Lia. A falha de busca e tratada como mensagem inline nao-bloqueante
 * dentro do idle (sem criar um estado de error novo). O empty distingue
 * 'sem embeddings indexados' de 'query valida sem resultados'.
 */
export function SemanticSearch() {
  const busca = useBuscaSemantica();
  const health = useHealthcheck();

  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const results = busca.data?.results ?? [];
  const loading = busca.isPending;
  const substratoVazio = (health.data?.totalAvisos ?? 0) === 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      // Query vazia validada no cliente: nao dispara a busca.
      setQueryError("Informe uma consulta em linguagem natural.");
      return;
    }
    setQueryError(null);
    setInlineError(null);
    try {
      await busca.mutateAsync({ query: trimmed, topK: normalizeTopK(topK) });
      setSearched(true);
    } catch {
      // Falha tratada como mensagem inline nao-bloqueante (permanece em idle).
      setInlineError(
        "Não foi possível concluir a busca semântica agora. Tente novamente em instantes.",
      );
    }
  }

  return (
    <div className="card">
      <form
        onSubmit={onSubmit}
        style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}
        noValidate
      >
        <div className={`field${queryError ? " invalid" : ""}`} style={{ flex: 1, margin: 0, minWidth: 260 }}>
          <label htmlFor="q">Consulta em linguagem natural</label>
          <input
            type="text"
            id="q"
            value={query}
            placeholder="Descreva o que a Lia precisa encontrar"
            aria-invalid={Boolean(queryError)}
            onChange={(e) => {
              setQuery(e.target.value);
              if (queryError) setQueryError(null);
            }}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {queryError}
          </div>
        </div>

        <div className="field" style={{ margin: 0, width: 120 }}>
          <label htmlFor="q-topk">Resultados</label>
          <select
            id="q-topk"
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value))}
          >
            {TOP_K_OPTIONS.map((n) => (
              <option key={n} value={n}>
                top {n}
              </option>
            ))}
          </select>
        </div>

        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? <Loader2 className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
          <span>{loading ? "Buscando…" : "Buscar"}</span>
        </button>
      </form>

      {inlineError && (
        <div className="banner" style={{ marginTop: 16, marginBottom: 0 }}>
          <TriangleAlert aria-hidden="true" />
          <div>
            <b>Busca indisponível</b>
            <p>{inlineError}</p>
          </div>
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        {loading ? (
          <div className="sub" style={{ color: "var(--faint)", fontSize: 12.5, padding: "8px 0" }}>
            Calculando embeddings da consulta…
          </div>
        ) : !searched ? (
          // idle: ainda nao houve busca.
          <div className="empty" style={{ padding: "30px 10px" }}>
            <Search aria-hidden="true" />
            <h4>Pronto para consultar o substrato</h4>
            <p>Descreva em linguagem natural o que a Lia precisa encontrar e dispare a busca.</p>
          </div>
        ) : results.length === 0 ? (
          substratoVazio ? (
            // empty: sem embeddings indexados.
            <div className="empty" style={{ padding: "30px 10px" }}>
              <Database aria-hidden="true" />
              <h4>Sem embeddings indexados</h4>
              <p>Indexe avisos (via coleta/reprocesso) para que a busca semântica retorne resultados.</p>
            </div>
          ) : (
            // empty: query valida, porem sem vizinhos relevantes.
            <div className="empty" style={{ padding: "30px 10px" }}>
              <Search aria-hidden="true" />
              <h4>Nenhum item relevante</h4>
              <p>Ajuste a consulta para recuperar avisos do substrato.</p>
            </div>
          )
        ) : (
          // success: resultados por relevancia.
          <>
            <div className="sub" style={{ marginBottom: 10, fontSize: 12, color: "var(--faint)" }}>
              {results.length} {results.length === 1 ? "item recuperado" : "itens recuperados"} por
              relevância (embeddings)
            </div>
            {results.map((r) => (
              <div className="result" key={r.id}>
                <div className="score">{r.score.toFixed(2)}</div>
                <div className="rinfo">
                  <b>{snippet(r.verbatim)}</b>
                  <span className="mono">aviso {r.id.slice(0, 8)}</span>
                </div>
                <div className="rmod">
                  <Link
                    href={`/edital/${r.id}`}
                    className="btn btn-sm"
                    aria-label={`Abrir o edital ${r.id}`}
                  >
                    <span>Ver edital</span>
                    <ChevronRight aria-hidden="true" />
                  </Link>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
