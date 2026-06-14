"use client";

import { useMemo, useState } from "react";
import { Boxes, Loader2, Plus, TriangleAlert, Trash2 } from "lucide-react";
import {
  useComposicao,
  useCreateComposicaoItem,
  useDeleteComposicaoItem,
} from "@/hooks/use-composicao";
import { useInsumos } from "@/hooks/use-insumos";
import { ApiError } from "@/lib/api/client";
import { categoriaLabel } from "@/components/cockpit/produtos/insumos-table";
import { cn } from "@/lib/utils";
import type { Insumo, SkuComposicaoItem } from "@/lib/api/types";

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? null : n;
}

/** Numero pt-BR com ate 6 casas, sem zeros a direita (ex.: 0,0625). */
function fmtNum(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 6 });
}

/** Modo de entrada da quantidade na BOM. */
type ModoQtd = "direto" | "rendimento";

/**
 * cmp-composicao-editor — edita a BOM (sku_composicao) de um SKU FABRICADO:
 * cada item e um insumo com quantidade e unidade. So insumos ATIVOS e ainda
 * NAO presentes entram no seletor (insumo inativo nao e selecionavel em novas
 * composicoes; duplicata e bloqueada com 409 pelo backend, exibido inline). As
 * escritas disparam o recalculo sincrono do SKU (triggers); os hooks invalidam
 * a composicao, os precos do SKU e a fila de pendentes.
 */
export function ComposicaoEditor({ skuId }: { skuId: string }) {
  const composicao = useComposicao(skuId);
  const insumosQuery = useInsumos({ limit: 500 });
  const criar = useCreateComposicaoItem();
  const remover = useDeleteComposicaoItem();

  const [insumoId, setInsumoId] = useState("");
  const [modo, setModo] = useState<ModoQtd>("direto");
  const [quantidade, setQuantidade] = useState("");
  const [rendimento, setRendimento] = useState("");
  const [unidade, setUnidade] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const items = useMemo(() => composicao.data?.items ?? [], [composicao.data]);
  const todosInsumos = useMemo(
    () => insumosQuery.data?.items ?? [],
    [insumosQuery.data],
  );

  // Mapa id -> insumo para resolver nome/unidade dos itens ja na BOM (inclusive
  // de insumos que possam ter ficado inativos).
  const insumoMap = useMemo(() => {
    const map = new Map<string, Insumo>();
    for (const i of todosInsumos) map.set(i.id, i);
    return map;
  }, [todosInsumos]);

  const usados = useMemo(
    () => new Set(items.map((i) => i.insumo_id)),
    [items],
  );

  // Seletor: somente ativos e ainda nao usados nesta composicao.
  const selecionaveis = useMemo(
    () => todosInsumos.filter((i) => i.ativo && !usados.has(i.id)),
    [todosInsumos, usados],
  );

  const insumoSelecionado = insumoMap.get(insumoId) ?? null;

  // Unidade do material (referencia do rendimento) e quantidade derivada para
  // o preview "cada peca usa X".
  const unidadeMaterial = insumoSelecionado?.unidade ?? (unidade.trim() || "un");
  const rendNum = toNumber(rendimento);
  const qtdDerivada = rendNum != null && rendNum > 0 ? 1 / rendNum : null;

  async function onAdd() {
    setErro(null);
    if (!insumoId) {
      setErro("Selecione um material.");
      return;
    }
    // Define quantidade por peca e, no modo rendimento, persiste o rendimento.
    let qtd: number | null;
    let rend: number | null = null;
    if (modo === "rendimento") {
      rend = toNumber(rendimento);
      if (rend == null || rend <= 0) {
        setErro("Informe um rendimento maior que zero (peças por unidade).");
        return;
      }
      qtd = 1 / rend;
    } else {
      qtd = toNumber(quantidade);
      if (qtd == null || qtd <= 0) {
        setErro("Informe uma quantidade maior que zero.");
        return;
      }
    }
    try {
      await criar.mutateAsync({
        skuId,
        input: {
          insumo_id: insumoId,
          quantidade: qtd,
          unidade: unidade.trim() ? unidade.trim() : null,
          rendimento: rend,
        },
      });
      setInsumoId("");
      setQuantidade("");
      setRendimento("");
      setUnidade("");
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 409
          ? "Este material já está na composição."
          : err instanceof ApiError && err.status === 400
            ? "Dados inválidos: revise material e quantidade."
            : "Não foi possível adicionar o item. Tente novamente.",
      );
    }
  }

  async function onRemove(item: SkuComposicaoItem) {
    setRemovingId(item.id);
    setErro(null);
    try {
      await remover.mutateAsync({ id: item.id, skuId });
    } catch {
      setErro("Não foi possível remover o item. Tente novamente.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Composição (BOM)</h3>
        <span className="count">{items.length} itens</span>
      </div>
      <p className="helper" style={{ margin: "0 0 14px" }}>
        Materiais e quantidades que compõem o custo variável deste SKU fabricado.
        O motor multiplica cada quantidade pelo preço vigente do material.
      </p>

      {composicao.isLoading ? (
        <div style={{ display: "grid", gap: 8 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <span key={i} className="skel skel-line" style={{ width: "100%" }} />
          ))}
        </div>
      ) : composicao.isError ? (
        <div className="empty">
          <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
          <h4>Não foi possível carregar a composição</h4>
          <p>Tente novamente em instantes.</p>
          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-sm" onClick={() => composicao.refetch()}>
              Tentar novamente
            </button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <Boxes aria-hidden="true" />
          <h4>Composição vazia</h4>
          <p>
            Adicione materiais abaixo. Sem composição (ou com material sem preço
            vigente), o SKU fica em estado de erro de cálculo.
          </p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Material</th>
                <th style={{ width: 140 }}>Quantidade</th>
                <th style={{ width: 90 }}>Unidade</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const insumo = insumoMap.get(item.insumo_id);
                return (
                  <tr key={item.id}>
                    <td>
                      <div className="cell-stack">
                        <b style={{ fontSize: "13.5px" }}>
                          {insumo?.nome ?? "Material removido"}
                        </b>
                        {insumo ? (
                          <span className="sub">
                            {categoriaLabel(insumo.categoria)}
                            {insumo.ativo ? "" : " · inativo"}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="tnum">
                      <div className="cell-stack">
                        <span>{fmtNum(item.quantidade)}</span>
                        {item.rendimento != null ? (
                          <span className="sub">
                            {fmtNum(item.rendimento)} pç/
                            {item.unidade ?? insumo?.unidade ?? "un"}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="mono">{item.unidade ?? insumo?.unidade ?? "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => onRemove(item)}
                        disabled={removingId === item.id}
                        aria-label={`Remover ${insumo?.nome ?? "item"}`}
                      >
                        {removingId === item.id ? (
                          <Loader2 className="spin" aria-hidden="true" />
                        ) : (
                          <Trash2 aria-hidden="true" />
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="field" style={{ marginTop: 16, marginBottom: 10 }}>
        <label>Como informar a quantidade</label>
        <div
          className="filter-group segmented"
          role="group"
          aria-label="Modo de entrada da quantidade"
          style={{ width: "fit-content" }}
        >
          <button
            type="button"
            className={cn("btn", "btn-sm", modo === "direto" && "btn-primary")}
            aria-pressed={modo === "direto"}
            onClick={() => {
              setModo("direto");
              setErro(null);
            }}
          >
            Quantidade por peça
          </button>
          <button
            type="button"
            className={cn("btn", "btn-sm", modo === "rendimento" && "btn-primary")}
            aria-pressed={modo === "rendimento"}
            onClick={() => {
              setModo("rendimento");
              setErro(null);
            }}
          >
            Rendimento
          </button>
        </div>
      </div>

      <div
        className="grid-fields"
        style={{ gridTemplateColumns: "1fr 150px 110px auto", alignItems: "end", gap: 12 }}
      >
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="comp-insumo">Material</label>
          <select
            id="comp-insumo"
            value={insumoId}
            onChange={(e) => {
              setInsumoId(e.target.value);
              setErro(null);
              const sel = insumoMap.get(e.target.value);
              if (sel && !unidade.trim()) setUnidade(sel.unidade);
            }}
            disabled={insumosQuery.isLoading || selecionaveis.length === 0}
          >
            <option value="">
              {selecionaveis.length === 0
                ? "Nenhum material ativo disponível"
                : "Selecione um material…"}
            </option>
            {selecionaveis.map((i) => (
              <option key={i.id} value={i.id}>
                {i.nome} ({i.unidade})
              </option>
            ))}
          </select>
        </div>
        {modo === "direto" ? (
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="comp-qtd">Quantidade</label>
            <input
              id="comp-qtd"
              type="number"
              step="any"
              min={0}
              placeholder="0"
              value={quantidade}
              onChange={(e) => {
                setQuantidade(e.target.value);
                setErro(null);
              }}
            />
          </div>
        ) : (
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="comp-rend">Peças por {unidadeMaterial}</label>
            <input
              id="comp-rend"
              type="number"
              step="any"
              min={0}
              placeholder="0"
              value={rendimento}
              onChange={(e) => {
                setRendimento(e.target.value);
                setErro(null);
              }}
            />
          </div>
        )}
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="comp-unidade">Unidade</label>
          <input
            id="comp-unidade"
            type="text"
            placeholder={insumoSelecionado?.unidade ?? "un"}
            value={unidade}
            onChange={(e) => setUnidade(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onAdd}
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
      {modo === "rendimento" && (
        <p
          className="helper"
          style={{ marginTop: 8 }}
        >
          1 {unidadeMaterial} rende {rendNum != null && rendNum > 0 ? fmtNum(rendNum) : "N"}{" "}
          peça(s) → cada peça usa{" "}
          <span className="tnum">
            {qtdDerivada != null ? `${fmtNum(qtdDerivada)} ${unidadeMaterial}` : "—"}
          </span>
          .
        </p>
      )}
      {erro && (
        <div className="err-msg" style={{ display: "flex", marginTop: 12 }}>
          <TriangleAlert aria-hidden="true" />
          {erro}
        </div>
      )}
    </div>
  );
}
