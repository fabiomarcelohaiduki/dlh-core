"use client";

import { ChevronRight, Package, Plus, Search, TriangleAlert } from "lucide-react";
import type { Insumo, InsumoCategoria } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/cockpit/status-pill";

/** Rotulo da categoria do insumo (insumos.categoria). */
export function categoriaLabel(categoria: InsumoCategoria): string {
  switch (categoria) {
    case "MP":
      return "Matéria-prima";
    case "embalagem":
      return "Embalagem";
    case "insumo":
    default:
      return "Insumo";
  }
}

function ativoDescriptor(ativo: boolean) {
  return ativo
    ? ({ state: "ok", label: "Ativo" } as const)
    : ({ state: "idle", label: "Inativo" } as const);
}

/**
 * cmp-insumos-table — lado MASTER do /insumos: lista os insumos com categoria,
 * unidade e status ativo/inativo (status-pill). Linhas clicaveis selecionam o
 * insumo para gerir os precos de fornecedor. Estados travados loading
 * (skeleton) / error / empty (com CTA). O estado inativo e visualmente
 * distinto: insumo inativo nao e selecionavel em novas composicoes (regra
 * aplicada no composicao-editor).
 */
export function InsumosTable({
  insumos,
  totalCadastrados = 0,
  busca = "",
  onBuscaChange,
  loading = false,
  isError = false,
  onRetry,
  selectedId,
  onSelect,
  onNew,
  onEdit,
}: {
  insumos: Insumo[];
  /** Total de insumos cadastrados (antes do filtro de busca). */
  totalCadastrados?: number;
  /** Termo de busca controlado pelo pai (filtro client-side por nome). */
  busca?: string;
  onBuscaChange?: (value: string) => void;
  loading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  selectedId?: string | null;
  onSelect: (insumo: Insumo) => void;
  onNew: () => void;
  onEdit: (insumo: Insumo) => void;
}) {
  if (isError) {
    return (
      <div className="tbl-wrap">
        <div className="empty">
          <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
          <h4>Não foi possível carregar os insumos</h4>
          <p>Verifique a conexão e tente novamente.</p>
          {onRetry && (
            <div style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-sm" onClick={onRetry}>
                Tentar novamente
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Materiais</h3>
        <span className="count">{insumos.length}</span>
        <button
          type="button"
          className="btn btn-sm btn-icon"
          style={{ marginLeft: "auto" }}
          onClick={onNew}
          aria-label="Novo material"
          title="Novo material"
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
      {onBuscaChange && (totalCadastrados > 0 || busca) && (
        <div style={{ position: "relative", margin: "0 0 12px" }}>
          <Search
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 11,
              top: "50%",
              transform: "translateY(-50%)",
              width: 15,
              height: 15,
              color: "var(--muted)",
              pointerEvents: "none",
            }}
          />
          <input
            type="text"
            value={busca}
            onChange={(e) => onBuscaChange(e.target.value)}
            placeholder="Buscar material…"
            aria-label="Buscar material por nome"
            style={{ width: "100%", paddingLeft: 34 }}
          />
        </div>
      )}
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Material</th>
              <th style={{ width: 56 }} aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                <td>
                  <span className="skel skel-line" style={{ width: `${55 + (i % 3) * 12}%` }} />
                </td>
                <td>
                  <span className="skel skel-line" style={{ width: "40%" }} />
                </td>
              </tr>
            ))
          ) : insumos.length === 0 ? (
            <tr>
              <td colSpan={2}>
                {busca ? (
                  <div className="empty">
                    <Search aria-hidden="true" />
                    <h4>Nenhum material encontrado</h4>
                    <p>
                      Nenhum material corresponde a “{busca}”. Ajuste ou limpe a
                      busca.
                    </p>
                  </div>
                ) : (
                  <div className="empty">
                    <Package aria-hidden="true" />
                    <h4>Nenhum material cadastrado</h4>
                    <p>
                      Os materiais (matéria-prima, embalagem, insumo) compõem a BOM
                      dos SKUs fabricados. Cadastre o primeiro para registrar preços.
                    </p>
                    <div style={{ marginTop: 16 }}>
                      <button type="button" className="btn btn-sm btn-primary" onClick={onNew}>
                        <Plus aria-hidden="true" />
                        <span>Novo material</span>
                      </button>
                    </div>
                  </div>
                )}
              </td>
            </tr>
          ) : (
            insumos.map((insumo) => {
              const desc = ativoDescriptor(insumo.ativo);
              const active = insumo.id === selectedId;
              return (
                <tr
                  key={insumo.id}
                  className={cn("clk", active && "active-row")}
                  aria-selected={active}
                  onClick={() => onSelect(insumo)}
                  style={active ? { background: "var(--accent-soft)" } : undefined}
                >
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <StatusPill state={desc.state} label={desc.label} iconOnly />
                      <div className="cell-stack">
                        <b style={{ fontSize: "13.5px" }}>{insumo.nome}</b>
                        <span className="sub">
                          {categoriaLabel(insumo.categoria)} · {insumo.unidade}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-end",
                      }}
                    >
                      <button
                        type="button"
                        className="btn btn-sm btn-icon"
                        style={{ color: "var(--accent)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(insumo);
                        }}
                        aria-label="Editar insumo"
                        title="Editar"
                      >
                        <ChevronRight aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
