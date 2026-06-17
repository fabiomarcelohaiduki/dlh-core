"use client";

import { useState } from "react";
import { useLinhas } from "@/hooks/use-linhas";
import { useProdutos } from "@/hooks/use-produtos";
import { ParametrosForm } from "@/components/cockpit/produtos/parametros-form";
import { PrecosPendentesList } from "@/components/cockpit/produtos/precos-pendentes-list";
import { cn } from "@/lib/utils";
import type { ParametroNivel } from "@/lib/api/types";

const NIVEIS: { value: ParametroNivel; label: string; hint: string }[] = [
  { value: "global", label: "Global", hint: "Base para todos os produtos" },
  { value: "linha", label: "Linha", hint: "Sobrescreve o global por linha" },
  { value: "produto", label: "Produto", hint: "Sobrescreve linha e global" },
];

/**
 * Corpo dos parâmetros de custo (3 níveis GLOBAL -> LINHA -> PRODUTO com vetor
 * regional e badges de origem efetiva/herdada), mais o bloco de SKUs pendentes
 * de recálculo. Fragmento sem wrapper .screen para poder viver dentro do drawer
 * de Produtos (ProdutosClient).
 */
export function ParametrosCustoPanel() {
  const [nivel, setNivel] = useState<ParametroNivel>("global");
  const [linhaId, setLinhaId] = useState("");
  const [produtoId, setProdutoId] = useState("");

  const linhas = useLinhas({ limit: 500 });
  const produtos = useProdutos({ limit: 500 });

  const linhaItems = linhas.data?.items ?? [];
  const produtoItems = produtos.data?.items ?? [];

  // Escopo efetivo do form conforme o nível selecionado.
  const escopoId =
    nivel === "linha"
      ? linhaId || null
      : nivel === "produto"
        ? produtoId || null
        : null;

  // Só renderiza o form quando o escopo está resolvido (global sempre; linha/
  // produto exigem seleção).
  const escopoPronto =
    nivel === "global" ||
    (nivel === "linha" && Boolean(linhaId)) ||
    (nivel === "produto" && Boolean(produtoId));

  return (
    <>
      <div className="card">
        <div className="section-title" style={{ margin: "0 0 13px" }}>
          <h3>Nível / escopo</h3>
        </div>
        <div className="chk-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
          {NIVEIS.map((n) => {
            const on = nivel === n.value;
            return (
              <label key={n.value} className={cn("chk", on && "on")}>
                <input
                  type="radio"
                  name="param-nivel"
                  checked={on}
                  onChange={() => setNivel(n.value)}
                />
                <div className="t">
                  {n.label}
                  <small>{n.hint}</small>
                </div>
              </label>
            );
          })}
        </div>

        {nivel === "linha" && (
          <div className="field" style={{ marginTop: 16, marginBottom: 0, maxWidth: 420 }}>
            <label htmlFor="param-linha">Linha</label>
            <select
              id="param-linha"
              value={linhaId}
              onChange={(e) => setLinhaId(e.target.value)}
              disabled={linhas.isLoading}
            >
              <option value="">Selecione uma linha…</option>
              {linhaItems.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nome}
                </option>
              ))}
            </select>
          </div>
        )}

        {nivel === "produto" && (
          <div className="field" style={{ marginTop: 16, marginBottom: 0, maxWidth: 420 }}>
            <label htmlFor="param-produto">Produto</label>
            <select
              id="param-produto"
              value={produtoId}
              onChange={(e) => setProdutoId(e.target.value)}
              disabled={produtos.isLoading}
            >
              <option value="">Selecione um produto…</option>
              {produtoItems.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {escopoPronto ? (
        <div style={{ marginTop: 16 }}>
          <ParametrosForm
            key={`${nivel}:${escopoId ?? "global"}`}
            nivel={nivel}
            escopoId={escopoId}
            produtoId={nivel === "produto" ? produtoId : undefined}
          />
        </div>
      ) : (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="empty">
            <h4>Selecione o escopo</h4>
            <p>
              Escolha {nivel === "linha" ? "uma Linha" : "um Produto"} acima para
              editar os parâmetros deste nível.
            </p>
          </div>
        </div>
      )}

      <div className="section-title">
        <h3>Recálculo</h3>
      </div>
      <PrecosPendentesList />
    </>
  );
}
