"use client";

import { useMemo, useState } from "react";
import { FileText, Printer, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProdutoLinha, Regiao } from "@/lib/api/types";

const REGIOES: { value: Regiao; label: string }[] = [
  { value: "S", label: "Sul" },
  { value: "SE", label: "Sudeste" },
  { value: "CO", label: "Centro-Oeste" },
  { value: "NE", label: "Nordeste" },
  { value: "N", label: "Norte" },
];

/** Colunas opcionais (alem de SKU, sempre presente, e das regioes). */
type Coluna = "fob" | "ll";
const COLUNAS: { value: Coluna; label: string }[] = [
  { value: "fob", label: "FOB" },
  { value: "ll", label: "LL%" },
];

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * cmp-gerar-tabela-modal — seletor que precede a geracao do PDF de precos.
 * Escolhe quais Linhas (uma/varias/todas) e quais regioes entram na tabela; ao
 * gerar, abre a rota de impressao em nova aba com a selecao na query. O formato
 * e fixo (planilha de engenharia: FOB + LL% + CIF Mín–Alvo por regiao), entao
 * nao ha escolha de patamar. Sem dado proprio — so monta a intencao.
 */
export function GerarTabelaModal({
  linhas,
  onClose,
}: {
  linhas: ProdutoLinha[];
  onClose: () => void;
}) {
  const [linhasSel, setLinhasSel] = useState<Set<string>>(new Set());
  const [regioesSel, setRegioesSel] = useState<Set<Regiao>>(
    new Set<Regiao>(REGIOES.map((r) => r.value)),
  );
  const [colsSel, setColsSel] = useState<Set<Coluna>>(
    new Set<Coluna>(COLUNAS.map((c) => c.value)),
  );
  const [quebraLinhas, setQuebraLinhas] = useState<Set<string>>(new Set());

  const todasLinhas = linhas.length > 0 && linhasSel.size === linhas.length;

  function toggleTodasLinhas() {
    setLinhasSel(todasLinhas ? new Set() : new Set(linhas.map((l) => l.id)));
  }

  const valido = useMemo(
    () => linhasSel.size > 0 && regioesSel.size > 0,
    [linhasSel, regioesSel],
  );

  function gerar() {
    if (!valido) return;
    // Preserva a ordem visual das linhas (e nao a ordem de clique).
    const linhasOrdenadas = linhas
      .filter((l) => linhasSel.has(l.id))
      .map((l) => l.id);
    const regioes = REGIOES.filter((r) => regioesSel.has(r.value)).map(
      (r) => r.value,
    );
    const colunas = COLUNAS.filter((c) => colsSel.has(c.value)).map((c) => c.value);
    const params = new URLSearchParams({
      linhas: linhasOrdenadas.join(","),
      regioes: regioes.join(","),
      colunas: colunas.join(","),
    });
    const quebra = linhas
      .filter((l) => linhasSel.has(l.id) && quebraLinhas.has(l.id))
      .map((l) => l.id);
    if (quebra.length > 0) params.set("quebraProdutoLinhas", quebra.join(","));
    window.open(`/produtos/tabela-precos/imprimir?${params.toString()}`, "_blank");
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Gerar tabela de preços"
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
          <h3>Gerar tabela de preços</h3>
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
        </div>

        <div className="field">
          <label>Colunas</label>
          <div className="chk-grid" role="group" aria-label="Colunas">
            {COLUNAS.map((c) => {
              const on = colsSel.has(c.value);
              return (
                <label key={c.value} className={cn("chk", on && "on")}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setColsSel((s) => toggle(s, c.value))}
                  />
                  <div className="t">{c.label}</div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label>Regiões</label>
          <div className="chk-grid" role="group" aria-label="Regiões">
            {REGIOES.map((r) => {
              const on = regioesSel.has(r.value);
              return (
                <label key={r.value} className={cn("chk", on && "on")}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setRegioesSel((s) => toggle(s, r.value))}
                  />
                  <div className="t">{r.label}</div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label>Quebrar página por produto</label>
          {linhasSel.size === 0 ? (
            <div className="helper">Selecione linhas acima para configurar.</div>
          ) : (
            <div className="chk-grid" role="group" aria-label="Quebrar por produto">
              {linhas
                .filter((l) => linhasSel.has(l.id))
                .map((l) => {
                  const on = quebraLinhas.has(l.id);
                  return (
                    <label key={l.id} className={cn("chk", on && "on")}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setQuebraLinhas((s) => toggle(s, l.id))}
                      />
                      <div className="t">{l.nome}</div>
                    </label>
                  );
                })}
            </div>
          )}
          <div className="helper">
            Cada linha já inicia em uma nova página. Marque as linhas em que cada
            produto também deve começar em página própria.
          </div>
        </div>

        {!valido && (
          <div className="helper" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <TriangleAlert aria-hidden="true" style={{ width: 14, height: 14 }} />
            Selecione ao menos uma linha e uma região.
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
