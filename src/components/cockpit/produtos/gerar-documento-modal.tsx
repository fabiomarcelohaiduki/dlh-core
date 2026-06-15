"use client";

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { FileText, Loader2, Printer, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { listProdutos } from "@/lib/api/produtos";
import { produtoKeys } from "@/hooks/use-produtos";
import type { ProdutoLinha } from "@/lib/api/types";

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * cmp-gerar-documento-modal — seletor compartilhado pelos documentos
 * imprimiveis de produtos (Catalogo e Ficha tecnica). Escolhe quais Linhas
 * entram e, dentro de cada Linha selecionada, quais Produtos (todos marcados
 * por padrao; o usuario desmarca os que nao quer). Ao gerar, abre a rota de
 * impressao em nova aba com a selecao na query: `linhas` (ordem visual) e, so
 * quando ha exclusao, `produtos` (lista explicita de incluidos). Sem dado
 * proprio — so monta a intencao. Os produtos seguem o mesmo filtro do
 * documento (ativo=true), entao a lista bate com o que sera impresso.
 */
export function GerarDocumentoModal({
  titulo,
  helper,
  rota,
  linhas,
  onClose,
}: {
  titulo: string;
  helper: string;
  rota: string;
  linhas: ProdutoLinha[];
  onClose: () => void;
}) {
  const [linhasSel, setLinhasSel] = useState<Set<string>>(new Set());
  // Exclusao explicita por produto; a inclusao e implicita (tudo que nao foi
  // excluido), evitando corrida com o carregamento dos produtos.
  const [excluidos, setExcluidos] = useState<Set<string>>(new Set());

  const todasLinhas = linhas.length > 0 && linhasSel.size === linhas.length;

  function toggleTodasLinhas() {
    setLinhasSel(todasLinhas ? new Set() : new Set(linhas.map((l) => l.id)));
  }

  // Linhas selecionadas na ordem visual (nao na ordem de clique).
  const linhasSelOrdenadas = useMemo(
    () => linhas.filter((l) => linhasSel.has(l.id)),
    [linhas, linhasSel],
  );

  // Um GET de produtos por Linha selecionada (mesmo filtro do documento).
  const produtosQueries = useQueries({
    queries: linhasSelOrdenadas.map((l) => ({
      queryKey: produtoKeys.list({ linha_id: l.id, ativo: true, limit: 500 }),
      queryFn: () => listProdutos({ linha_id: l.id, ativo: true, limit: 500 }),
    })),
  });

  const carregandoProdutos = produtosQueries.some((q) => q.isLoading);

  // Lista explicita de produtos incluidos (so usada quando ha exclusao).
  const incluidos = useMemo(() => {
    const ids: string[] = [];
    linhasSelOrdenadas.forEach((_l, i) => {
      for (const p of produtosQueries[i]?.data?.items ?? []) {
        if (!excluidos.has(p.id)) ids.push(p.id);
      }
    });
    return ids;
  }, [linhasSelOrdenadas, produtosQueries, excluidos]);

  const valido = useMemo(() => {
    if (linhasSel.size === 0) return false;
    if (excluidos.size === 0) return true; // inclui tudo, sem depender do load
    return !carregandoProdutos && incluidos.length > 0;
  }, [linhasSel, excluidos, carregandoProdutos, incluidos]);

  function gerar() {
    if (!valido) return;
    const params = new URLSearchParams({
      linhas: linhasSelOrdenadas.map((l) => l.id).join(","),
    });
    // So envia a lista de produtos quando ha exclusao; sem exclusao, a rota
    // imprime todos os produtos das linhas (sem depender do load deste modal).
    if (excluidos.size > 0) params.set("produtos", incluidos.join(","));
    window.open(`${rota}?${params.toString()}`, "_blank");
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "8vh 16px 16px",
        overflowY: "auto",
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(640px, 100%)", maxWidth: 640 }}
      >
        <div className="section-title" style={{ margin: "0 0 14px" }}>
          <h3>{titulo}</h3>
          <button
            type="button"
            className="btn btn-sm btn-icon"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Fechar"
            title="Fechar"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="field">
          <label>
            Linhas
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: 10 }}
              onClick={toggleTodasLinhas}
            >
              {todasLinhas ? "Limpar" : "Selecionar todas"}
            </button>
          </label>
          {linhas.length === 0 ? (
            <div className="helper">Nenhuma linha cadastrada.</div>
          ) : (
            <div className="chk-grid" role="group" aria-label="Linhas">
              {linhas.map((l) => {
                const on = linhasSel.has(l.id);
                return (
                  <label key={l.id} className={cn("chk", on && "on")}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setLinhasSel((s) => toggle(s, l.id))}
                    />
                    <div className="t">{l.nome}</div>
                  </label>
                );
              })}
            </div>
          )}
          <div className="helper">{helper}</div>
        </div>

        {linhasSelOrdenadas.length > 0 ? (
          <div className="field">
            <label>Produtos</label>
            {linhasSelOrdenadas.map((l, i) => {
              const q = produtosQueries[i];
              const produtos = q?.data?.items ?? [];
              return (
                <div key={l.id} style={{ marginTop: i === 0 ? 0 : 12 }}>
                  <div
                    className="helper"
                    style={{ fontWeight: 600, color: "var(--text-fg)", margin: "0 0 6px" }}
                  >
                    {l.nome}
                  </div>
                  {q?.isLoading ? (
                    <div
                      className="helper"
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <Loader2 className="spin" aria-hidden="true" style={{ width: 14, height: 14 }} />
                      Carregando produtos…
                    </div>
                  ) : q?.isError ? (
                    <div className="helper">Não foi possível carregar os produtos desta linha.</div>
                  ) : produtos.length === 0 ? (
                    <div className="helper">Nenhum produto ativo nesta linha.</div>
                  ) : (
                    <div className="chk-grid" role="group" aria-label={`Produtos de ${l.nome}`}>
                      {produtos.map((p) => {
                        const on = !excluidos.has(p.id);
                        return (
                          <label key={p.id} className={cn("chk", on && "on")}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => setExcluidos((s) => toggle(s, p.id))}
                            />
                            <div className="t">{p.nome}</div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="helper">
              Todos vêm marcados. Desmarque os produtos que não devem entrar no documento.
            </div>
          </div>
        ) : null}

        {linhasSel.size === 0 ? (
          <div className="helper" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <TriangleAlert aria-hidden="true" style={{ width: 14, height: 14 }} />
            Selecione ao menos uma linha.
          </div>
        ) : !valido && !carregandoProdutos ? (
          <div className="helper" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <TriangleAlert aria-hidden="true" style={{ width: 14, height: 14 }} />
            Selecione ao menos um produto.
          </div>
        ) : null}

        <div className="form-foot" style={{ marginTop: 18 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={gerar}
            disabled={!valido}
          >
            <Printer aria-hidden="true" />
            <span>Gerar e imprimir</span>
          </button>
          <button type="button" className="btn" onClick={onClose}>
            <FileText aria-hidden="true" />
            <span>Cancelar</span>
          </button>
        </div>
      </div>
    </div>
  );
}
