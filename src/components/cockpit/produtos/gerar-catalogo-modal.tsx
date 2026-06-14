"use client";

import { useMemo, useState } from "react";
import { FileText, Printer, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProdutoLinha } from "@/lib/api/types";

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * cmp-gerar-catalogo-modal — seletor que precede a geracao do PDF de catalogo.
 * Escolhe quais Linhas entram no documento; ao gerar, abre a rota de impressao
 * em nova aba com a selecao na query. O catalogo distribui os produtos em cards
 * (grade 2 colunas) ao longo das paginas, mostrando so os atributos marcados
 * como "aparece no catalogo". Sem preco. Sem dado proprio — so monta a intencao.
 */
export function GerarCatalogoModal({
  linhas,
  onClose,
}: {
  linhas: ProdutoLinha[];
  onClose: () => void;
}) {
  const [linhasSel, setLinhasSel] = useState<Set<string>>(new Set());
  const todasLinhas = linhas.length > 0 && linhasSel.size === linhas.length;

  function toggleTodasLinhas() {
    setLinhasSel(todasLinhas ? new Set() : new Set(linhas.map((l) => l.id)));
  }

  const valido = useMemo(() => linhasSel.size > 0, [linhasSel]);

  function gerar() {
    if (!valido) return;
    // Preserva a ordem visual das linhas (e nao a ordem de clique).
    const linhasOrdenadas = linhas
      .filter((l) => linhasSel.has(l.id))
      .map((l) => l.id);
    const params = new URLSearchParams({ linhas: linhasOrdenadas.join(",") });
    window.open(`/produtos/catalogo/imprimir?${params.toString()}`, "_blank");
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Gerar catálogo"
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
          <h3>Gerar catálogo</h3>
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
          <div className="helper">
            Cada produto vira um card. Aparecem apenas os atributos marcados como
            visíveis no catálogo.
          </div>
        </div>

        {!valido && (
          <div className="helper" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <TriangleAlert aria-hidden="true" style={{ width: 14, height: 14 }} />
            Selecione ao menos uma linha.
          </div>
        )}

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
