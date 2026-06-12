"use client";

import { Package, Plus, TriangleAlert } from "lucide-react";
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
  loading = false,
  isError = false,
  onRetry,
  selectedId,
  onSelect,
  onNew,
}: {
  insumos: Insumo[];
  loading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  selectedId?: string | null;
  onSelect: (insumo: Insumo) => void;
  onNew: () => void;
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
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Insumo</th>
            <th style={{ width: 90 }}>Unidade</th>
            <th style={{ width: 100 }}>Status</th>
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
                  <span className="skel skel-line" style={{ width: "60%" }} />
                </td>
                <td>
                  <span className="skel skel-pill" />
                </td>
              </tr>
            ))
          ) : insumos.length === 0 ? (
            <tr>
              <td colSpan={3}>
                <div className="empty">
                  <Package aria-hidden="true" />
                  <h4>Nenhum insumo cadastrado</h4>
                  <p>
                    Os insumos (matéria-prima, embalagem) compõem a BOM dos SKUs
                    fabricados. Cadastre o primeiro para registrar preços.
                  </p>
                  <div style={{ marginTop: 16 }}>
                    <button type="button" className="btn btn-sm btn-primary" onClick={onNew}>
                      <Plus aria-hidden="true" />
                      <span>Novo insumo</span>
                    </button>
                  </div>
                </div>
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
                    <div className="cell-stack">
                      <b style={{ fontSize: "13.5px" }}>{insumo.nome}</b>
                      <span className="sub">{categoriaLabel(insumo.categoria)}</span>
                    </div>
                  </td>
                  <td className="mono">{insumo.unidade}</td>
                  <td>
                    <StatusPill state={desc.state} label={desc.label} />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
