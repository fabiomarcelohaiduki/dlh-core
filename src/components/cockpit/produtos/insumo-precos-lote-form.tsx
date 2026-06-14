"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Plus, TriangleAlert } from "lucide-react";
import {
  useCreateInsumoPreco,
  useInsumoPrecos,
  useUpdateInsumoPrecosBatch,
} from "@/hooks/use-insumo-precos";
import { ApiError } from "@/lib/api/client";
import { StatusPill } from "@/components/cockpit/status-pill";
import { formatCurrency, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Insumo, InsumoPreco } from "@/lib/api/types";

/** Limite de itens por edicao em lote (espelha o backend: 400 acima de 200). */
const MAX_BATCH = 200;

/** Hoje em "YYYY-MM-DD" (local) para a comparacao lexicografica de vigencia. */
function hojeISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Faixa vigente: inicio <= hoje E (fim nulo OU fim >= hoje). */
function isVigente(preco: InsumoPreco, hoje: string): boolean {
  if (preco.vigencia_inicio > hoje) return false;
  return preco.vigencia_fim == null || preco.vigencia_fim >= hoje;
}

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? null : n;
}

type Feedback = { kind: "ok" | "err"; msg: string };

/**
 * cmp-insumo-precos-lote-form — historico de precos de fornecedor de um insumo
 * com a faixa VIGENTE em destaque (status-pill). Permite a EDICAO EM LOTE dos
 * precos exibidos (so as celulas alteradas viram o batch PUT /insumo-precos/
 * batch, ate MAX_BATCH itens) e a criacao de uma nova faixa de vigencia
 * (POST), preservando o historico. As escritas disparam o recalculo SINCRONO
 * dos SKUs cuja BOM usa o insumo (triggers no backend); os hooks ja invalidam
 * os precos e a fila de pendentes.
 */
export function InsumoPrecosLoteForm({ insumo }: { insumo: Insumo }) {
  const precos = useInsumoPrecos(insumo.id);
  const batch = useUpdateInsumoPrecosBatch();
  const criar = useCreateInsumoPreco();

  const hoje = useMemo(() => hojeISO(), []);
  const items = useMemo(() => precos.data?.items ?? [], [precos.data]);

  // edits: id -> valor textual do input. Inicializa/reidrata ao trocar o insumo
  // ou ao recarregar os precos.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const p of items) next[p.id] = String(p.preco);
    setEdits(next);
    setFeedback(null);
  }, [items]);

  // Novo preco (faixa de vigencia).
  const [novoFornecedor, setNovoFornecedor] = useState("");
  const [novoPreco, setNovoPreco] = useState("");
  const [novoInicio, setNovoInicio] = useState(hoje);
  const [novoFim, setNovoFim] = useState("");
  const [novoErro, setNovoErro] = useState<string | null>(null);

  const changed = useMemo(() => {
    const list: { id: string; preco: number }[] = [];
    for (const p of items) {
      const raw = edits[p.id];
      if (raw == null) continue;
      const n = toNumber(raw);
      if (n == null) continue;
      if (n !== p.preco) list.push({ id: p.id, preco: n });
    }
    return list;
  }, [items, edits]);

  async function onSaveBatch() {
    setFeedback(null);
    if (changed.length === 0) {
      setFeedback({ kind: "err", msg: "Nenhum preço foi alterado." });
      return;
    }
    if (changed.length > MAX_BATCH) {
      setFeedback({
        kind: "err",
        msg: `Limite de ${MAX_BATCH} preços por edição em lote (${changed.length} alterados).`,
      });
      return;
    }
    try {
      const res = await batch.mutateAsync(changed);
      setFeedback({
        kind: "ok",
        msg: `${res.updated} preço(s) atualizados · ${res.skus_marcados_recalculo} SKU(s) marcados para recálculo.`,
      });
    } catch (err) {
      setFeedback({
        kind: "err",
        msg:
          err instanceof ApiError && err.status === 400
            ? "Edição em lote inválida: revise os valores e o limite de itens."
            : "Não foi possível salvar os preços. Tente novamente.",
      });
    }
  }

  async function onCriar() {
    setNovoErro(null);
    const precoNum = toNumber(novoPreco);
    if (precoNum == null || precoNum < 0) {
      setNovoErro("Informe um preço válido.");
      return;
    }
    if (!novoInicio) {
      setNovoErro("Informe o início da vigência.");
      return;
    }
    if (novoFim && novoFim < novoInicio) {
      setNovoErro("O fim da vigência não pode ser anterior ao início.");
      return;
    }
    try {
      await criar.mutateAsync({
        insumoId: insumo.id,
        input: {
          fornecedor: novoFornecedor.trim() ? novoFornecedor.trim() : null,
          preco: precoNum,
          vigencia_inicio: novoInicio,
          vigencia_fim: novoFim ? novoFim : null,
        },
      });
      setNovoFornecedor("");
      setNovoPreco("");
      setNovoInicio(hoje);
      setNovoFim("");
    } catch (err) {
      setNovoErro(
        err instanceof ApiError && err.status === 400
          ? "Dados inválidos: revise o preço e as datas."
          : "Não foi possível adicionar o preço. Tente novamente.",
      );
    }
  }

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Preços de fornecedor</h3>
        <span className="count">{items.length}</span>
      </div>

      {precos.isLoading ? (
        <div style={{ display: "grid", gap: 8 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <span key={i} className="skel skel-line" style={{ width: "100%" }} />
          ))}
        </div>
      ) : precos.isError ? (
        <div className="empty">
          <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
          <h4>Não foi possível carregar os preços</h4>
          <p>Tente novamente em instantes.</p>
          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-sm" onClick={() => precos.refetch()}>
              Tentar novamente
            </button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <Plus aria-hidden="true" />
          <h4>Nenhum preço registrado</h4>
          <p>Adicione a primeira faixa de vigência abaixo para habilitar o cálculo.</p>
        </div>
      ) : (
        <div className="tbl-wrap tbl-scroll">
          <table style={{ minWidth: 560 }}>
            <thead>
              <tr>
                <th>Fornecedor</th>
                <th style={{ width: 160 }}>Preço</th>
                <th style={{ width: 120 }}>Início</th>
                <th style={{ width: 120 }}>Fim</th>
                <th style={{ width: 110 }}>Vigência</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const vigente = isVigente(p, hoje);
                const edited =
                  edits[p.id] != null && toNumber(edits[p.id]) !== p.preco;
                return (
                  <tr
                    key={p.id}
                    style={vigente ? { background: "var(--accent-soft)" } : undefined}
                  >
                    <td className="sub">{p.fornecedor ?? "—"}</td>
                    <td>
                      <div className="input-affix" style={{ maxWidth: 150 }}>
                        <input
                          type="number"
                          step="any"
                          min={0}
                          aria-label={`Preço da faixa ${formatDate(p.vigencia_inicio)}`}
                          value={edits[p.id] ?? ""}
                          onChange={(e) => {
                            setEdits((prev) => ({ ...prev, [p.id]: e.target.value }));
                            setFeedback(null);
                          }}
                          style={
                            edited
                              ? { borderColor: "var(--accent-line)" }
                              : undefined
                          }
                        />
                      </div>
                    </td>
                    <td className="mono">{formatDate(p.vigencia_inicio)}</td>
                    <td className="mono">{p.vigencia_fim ? formatDate(p.vigencia_fim) : "—"}</td>
                    <td>
                      {vigente ? (
                        <StatusPill state="ok" label="Vigente" />
                      ) : (
                        <span style={{ color: "var(--faint)" }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {items.length > 0 && (
        <div className="form-foot" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSaveBatch}
            disabled={batch.isPending || changed.length === 0}
          >
            {batch.isPending ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            <span>
              {batch.isPending
                ? "Salvando…"
                : changed.length > 0
                  ? `Salvar ${changed.length} preço(s)`
                  : "Salvar preços"}
            </span>
          </button>
          {feedback && (
            <span className={cn("save-note", feedback.kind === "err" && "err")}>
              {feedback.kind === "err" ? (
                <TriangleAlert aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {feedback.msg}
            </span>
          )}
        </div>
      )}

      <div className="section-title" style={{ margin: "24px 0 13px" }}>
        <h3>Nova faixa de preço</h3>
      </div>
      <div
        className="grid-fields"
        style={{
          gridTemplateColumns:
            "minmax(120px, 1fr) minmax(0, 150px) minmax(0, 140px) minmax(0, 140px) auto",
          alignItems: "end",
          gap: 12,
        }}
      >
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="novo-fornecedor">Fornecedor</label>
          <input
            id="novo-fornecedor"
            type="text"
            placeholder="Opcional"
            value={novoFornecedor}
            onChange={(e) => setNovoFornecedor(e.target.value)}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="novo-preco">Preço</label>
          <input
            id="novo-preco"
            type="number"
            step="any"
            min={0}
            placeholder="0,00"
            value={novoPreco}
            onChange={(e) => {
              setNovoPreco(e.target.value);
              setNovoErro(null);
            }}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="novo-inicio">Início</label>
          <input
            id="novo-inicio"
            type="date"
            value={novoInicio}
            onChange={(e) => {
              setNovoInicio(e.target.value);
              setNovoErro(null);
            }}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="novo-fim">Fim</label>
          <input
            id="novo-fim"
            type="date"
            value={novoFim}
            onChange={(e) => {
              setNovoFim(e.target.value);
              setNovoErro(null);
            }}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCriar}
          disabled={criar.isPending}
        >
          {criar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Plus aria-hidden="true" />
          )}
          <span>Adicionar</span>
        </button>
      </div>
      <div className="helper" style={{ marginTop: 8 }}>
        Deixe o fim em branco para uma vigência aberta. Preço atual:{" "}
        <span className="tnum">
          {formatCurrency(items.find((p) => isVigente(p, hoje))?.preco ?? null)}
        </span>
      </div>
      {novoErro && (
        <div className="err-msg" style={{ display: "flex", marginTop: 12 }}>
          <TriangleAlert aria-hidden="true" />
          {novoErro}
        </div>
      )}
    </div>
  );
}
