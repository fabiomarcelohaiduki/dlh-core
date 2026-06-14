"use client";

import { useMemo, useState } from "react";
import { Check, Circle, CircleCheck, Loader2, Plus, ShoppingCart, Trash2, TriangleAlert, X } from "lucide-react";
import {
  useCreateCustoAquisicao,
  useCustoAquisicaoHistorico,
  useDeleteCustoAquisicao,
} from "@/hooks/use-custo-aquisicao";
import { ApiError } from "@/lib/api/client";
import { formatCurrency, formatDate } from "@/lib/format";
import type { SkuCustoAquisicao } from "@/lib/api/types";

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? null : n;
}

function hojeISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isVigente(c: SkuCustoAquisicao, hoje: string): boolean {
  if (c.vigencia_inicio > hoje) return false;
  return c.vigencia_fim == null || c.vigencia_fim >= hoje;
}

/**
 * cmp-custo-aquisicao-form — custo de aquisicao (sku_custo_aquisicao) de um SKU
 * COMPRADO, com historico de vigencia: a faixa vigente fica destacada
 * (status-pill) e novas faixas preservam o historico (POST). Sem custo vigente,
 * o SKU comprado fica em estado de erro de calculo. As escritas disparam o
 * recalculo sincrono do SKU (triggers); os hooks invalidam o custo, os precos e
 * a fila de pendentes.
 */
export function CustoAquisicaoForm({ skuId }: { skuId: string }) {
  const historico = useCustoAquisicaoHistorico(skuId);
  const criar = useCreateCustoAquisicao();
  const remover = useDeleteCustoAquisicao();

  const hoje = useMemo(() => hojeISO(), []);
  const items = useMemo(() => historico.data?.items ?? [], [historico.data]);
  const vigente = useMemo(
    () => items.find((c) => isVigente(c, hoje)) ?? null,
    [items, hoje],
  );
  // Append-only: a lista vem desc por vigencia_inicio. So a PRIMEIRA faixa
  // valida e a vigente efetiva; as anteriores em aberto foram substituidas.
  const vigenteId = vigente?.id ?? null;

  const [fornecedor, setFornecedor] = useState("");
  const [custo, setCusto] = useState("");
  const [inicio, setInicio] = useState(hoje);
  const [fim, setFim] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [confirmandoId, setConfirmandoId] = useState<string | null>(null);

  async function onCriar() {
    setErro(null);
    const custoNum = toNumber(custo);
    if (custoNum == null || custoNum < 0) {
      setErro("Informe um custo válido.");
      return;
    }
    if (!inicio) {
      setErro("Informe o início da vigência.");
      return;
    }
    if (fim && fim < inicio) {
      setErro("O fim da vigência não pode ser anterior ao início.");
      return;
    }
    try {
      await criar.mutateAsync({
        skuId,
        input: {
          fornecedor: fornecedor.trim() ? fornecedor.trim() : null,
          custo: custoNum,
          vigencia_inicio: inicio,
          vigencia_fim: fim ? fim : null,
        },
      });
      setFornecedor("");
      setCusto("");
      setInicio(hoje);
      setFim("");
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 400
          ? "Dados inválidos: revise o custo e as datas."
          : "Não foi possível adicionar o custo. Tente novamente.",
      );
    }
  }

  async function onRemover(id: string) {
    setErro(null);
    try {
      await remover.mutateAsync({ id, skuId });
      setConfirmandoId(null);
    } catch {
      setErro("Não foi possível remover a faixa. Tente novamente.");
    }
  }

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Custo de aquisição</h3>
        <span className="count">{items.length}</span>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: "12.5px", color: "var(--muted)" }}>
        SKU comprado: o custo variável vem do custo de aquisição vigente. Novas
        faixas preservam o histórico.
      </p>

      {historico.isLoading ? (
        <div style={{ display: "grid", gap: 8 }}>
          {Array.from({ length: 2 }).map((_, i) => (
            <span key={i} className="skel skel-line" style={{ width: "100%" }} />
          ))}
        </div>
      ) : historico.isError ? (
        <div className="empty">
          <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
          <h4>Não foi possível carregar o histórico</h4>
          <p>Tente novamente em instantes.</p>
          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-sm" onClick={() => historico.refetch()}>
              Tentar novamente
            </button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <ShoppingCart aria-hidden="true" />
          <h4>Nenhum custo registrado</h4>
          <p>Adicione a primeira faixa de vigência para habilitar o cálculo do SKU.</p>
        </div>
      ) : (
        <div className="tbl-wrap tbl-scroll">
          <table style={{ width: "100%", minWidth: 460 }}>
            <thead>
              <tr>
                <th style={{ width: "33%" }}>Fornecedor</th>
                <th style={{ width: "30%", textAlign: "center" }}>Custo</th>
                <th style={{ width: "15%", textAlign: "center" }}>Início</th>
                <th style={{ width: "11%", textAlign: "center" }}>Fim</th>
                <th style={{ width: "5%", textAlign: "center" }}>Vigência</th>
                <th style={{ width: "6%" }} aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const v = c.id === vigenteId;
                const substituida = vigenteId != null && isVigente(c, hoje) && !v;
                return (
                  <tr
                    key={c.id}
                    style={v ? { background: "var(--accent-soft)" } : undefined}
                  >
                    <td>{c.fornecedor ?? "—"}</td>
                    <td className="tnum" style={{ textAlign: "center" }}>
                      {formatCurrency(c.custo)}
                    </td>
                    <td className="mono" style={{ textAlign: "center" }}>
                      {formatDate(c.vigencia_inicio)}
                    </td>
                    <td className="mono" style={{ textAlign: "center" }}>
                      {c.vigencia_fim ? formatDate(c.vigencia_fim) : "—"}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      {v ? (
                        <span
                          title="Vigente"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            height: 30,
                          }}
                        >
                          <CircleCheck size={20} aria-label="Vigente" style={{ color: "var(--ok)" }} />
                        </span>
                      ) : substituida ? (
                        <span
                          title="Substituída"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            height: 30,
                          }}
                        >
                          <Circle size={20} aria-label="Substituída" style={{ color: "var(--muted)" }} />
                        </span>
                      ) : (
                        <span style={{ color: "var(--faint)" }}>—</span>
                      )}
                    </td>
                    <td>
                      {confirmandoId === c.id ? (
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            type="button"
                            className="btn btn-sm btn-icon"
                            style={{ color: "var(--err)" }}
                            aria-label="Confirmar exclusão da faixa"
                            title="Confirmar exclusão"
                            onClick={() => onRemover(c.id)}
                            disabled={remover.isPending}
                          >
                            {remover.isPending ? (
                              <Loader2 className="spin" aria-hidden="true" />
                            ) : (
                              <Check aria-hidden="true" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-icon"
                            aria-label="Cancelar exclusão"
                            title="Cancelar"
                            onClick={() => setConfirmandoId(null)}
                            disabled={remover.isPending}
                          >
                            <X aria-hidden="true" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm btn-icon"
                          aria-label={`Excluir faixa de ${formatDate(c.vigencia_inicio)}`}
                          title="Excluir faixa"
                          onClick={() => setConfirmandoId(c.id)}
                        >
                          <Trash2 aria-hidden="true" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-title" style={{ margin: "24px 0 13px" }}>
        <h3>Nova faixa de custo</h3>
      </div>
      <div
        className="grid-fields"
        style={{ gridTemplateColumns: "1fr 150px 140px 140px auto", alignItems: "end", gap: 12 }}
      >
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="custo-fornecedor">Fornecedor</label>
          <input
            id="custo-fornecedor"
            type="text"
            placeholder="Opcional"
            value={fornecedor}
            onChange={(e) => setFornecedor(e.target.value)}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="custo-valor">Custo</label>
          <input
            id="custo-valor"
            type="number"
            step="any"
            min={0}
            placeholder="0,00"
            value={custo}
            onChange={(e) => {
              setCusto(e.target.value);
              setErro(null);
            }}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="custo-inicio">Início</label>
          <input
            id="custo-inicio"
            type="date"
            value={inicio}
            onChange={(e) => {
              setInicio(e.target.value);
              setErro(null);
            }}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="custo-fim">Fim</label>
          <input
            id="custo-fim"
            type="date"
            value={fim}
            onChange={(e) => {
              setFim(e.target.value);
              setErro(null);
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
      <p style={{ margin: "8px 0 0", fontSize: "12.5px", color: "var(--muted)" }}>
        Deixe o fim em branco para uma vigência aberta.
      </p>
      {erro && (
        <div className="err-msg" style={{ display: "flex", marginTop: 12 }}>
          <TriangleAlert aria-hidden="true" />
          {erro}
        </div>
      )}
    </div>
  );
}
