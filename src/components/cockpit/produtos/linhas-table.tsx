"use client";

import { ChevronRight, Layers, Plus, TriangleAlert } from "lucide-react";
import type { ProdutoLinha } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/cockpit/status-pill";

function ativoDescriptor(ativo: boolean) {
  return ativo
    ? ({ state: "ok", label: "Ativa" } as const)
    : ({ state: "idle", label: "Inativa" } as const);
}

/**
 * cmp-linhas-table — lado MASTER do /produtos: lista as Linhas com status
 * ativo/inativo (status-pill) e linhas clicaveis para o drill-down dos Produtos
 * da Linha. O simbolo laranja (chevron) abre a edicao da Linha; a exclusao vive
 * dentro do editar. Estados travados loading (skeleton) / error / empty (com CTA).
 */
export function LinhasTable({
  linhas,
  loading = false,
  isError = false,
  onRetry,
  selectedId,
  onSelect,
  onNew,
  onEdit,
}: {
  linhas: ProdutoLinha[];
  loading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  selectedId?: string | null;
  onSelect: (linha: ProdutoLinha) => void;
  onNew: () => void;
  onEdit: (linha: ProdutoLinha) => void;
}) {
  if (isError) {
    return (
      <div className="tbl-wrap">
        <div className="empty">
          <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
          <h4>Não foi possível carregar as linhas</h4>
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
        <h3>Linhas</h3>
        <span className="count">{linhas.length}</span>
        <button
          type="button"
          className="btn btn-sm btn-icon"
          style={{ marginLeft: "auto" }}
          onClick={onNew}
          aria-label="Nova linha"
          title="Nova linha"
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Linha</th>
              <th style={{ width: 150 }} aria-label="Status" />
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
                  <span className="skel skel-pill" />
                </td>
              </tr>
            ))
          ) : linhas.length === 0 ? (
            <tr>
              <td colSpan={2}>
                <div className="empty">
                  <Layers aria-hidden="true" />
                  <h4>Nenhuma linha cadastrada</h4>
                  <p>
                    As Linhas agrupam os Produtos e definem os atributos que cada
                    Produto preenche. Crie a primeira para começar.
                  </p>
                  <div style={{ marginTop: 16 }}>
                    <button type="button" className="btn btn-sm btn-primary" onClick={onNew}>
                      <Plus aria-hidden="true" />
                      <span>Nova linha</span>
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          ) : (
            linhas.map((l) => {
              const desc = ativoDescriptor(l.ativo);
              const active = l.id === selectedId;
              return (
                <tr
                  key={l.id}
                  className={cn("clk", active && "active-row")}
                  aria-selected={active}
                  onClick={() => onSelect(l)}
                  style={
                    active
                      ? { background: "var(--accent-soft)" }
                      : undefined
                  }
                >
                  <td>
                    <div className="cell-stack">
                      <b style={{ fontSize: "13.5px" }}>{l.nome}</b>
                      {l.descricao ? (
                        <span className="sub">{l.descricao}</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-end",
                        gap: 8,
                      }}
                    >
                      <StatusPill state={desc.state} label={desc.label} iconOnly />
                      <button
                        type="button"
                        className="btn btn-sm btn-icon"
                        style={{ color: "var(--accent)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(l);
                        }}
                        aria-label="Editar linha"
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
