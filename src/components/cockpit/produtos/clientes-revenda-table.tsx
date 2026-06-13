"use client";

import { ChevronRight, Plus, Store, TriangleAlert } from "lucide-react";
import type { ClienteRevenda } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/cockpit/status-pill";

function ativoDescriptor(ativo: boolean) {
  return ativo
    ? ({ state: "ok", label: "Ativo" } as const)
    : ({ state: "idle", label: "Inativo" } as const);
}

/**
 * cmp-clientes-revenda-table — lado MASTER do /revenda: lista os clientes do
 * canal de revenda com status ativo/inativo (status-pill). Linhas clicaveis
 * selecionam o cliente para gerir a sua tabela de precos por SKU. Estados
 * travados loading (skeleton) / error / empty (com CTA). Canal de revenda e
 * SEPARADO do preco de licitacao.
 */
export function ClientesRevendaTable({
  clientes,
  loading = false,
  isError = false,
  onRetry,
  selectedId,
  onSelect,
  onNew,
  onEdit,
}: {
  clientes: ClienteRevenda[];
  loading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  selectedId?: string | null;
  onSelect: (cliente: ClienteRevenda) => void;
  onNew: () => void;
  onEdit: (cliente: ClienteRevenda) => void;
}) {
  if (isError) {
    return (
      <div className="tbl-wrap">
        <div className="empty">
          <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
          <h4>Não foi possível carregar os clientes</h4>
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
        <h3>Clientes de revenda</h3>
        <span className="count">{clientes.length}</span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Cliente de revenda</th>
              <th style={{ width: 100 }}>Status</th>
              <th style={{ width: 56 }}>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-icon"
                    onClick={onNew}
                    aria-label="Novo cliente"
                    title="Novo cliente"
                  >
                    <Plus aria-hidden="true" />
                  </button>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                <td>
                  <span
                    className="skel skel-line"
                    style={{ width: `${55 + (i % 3) * 12}%` }}
                  />
                </td>
                <td>
                  <span className="skel skel-pill" />
                </td>
                <td>
                  <span className="skel skel-line" style={{ width: "40%" }} />
                </td>
              </tr>
            ))
          ) : clientes.length === 0 ? (
            <tr>
              <td colSpan={3}>
                <div className="empty">
                  <Store aria-hidden="true" />
                  <h4>Nenhum cliente de revenda</h4>
                  <p>
                    Cadastre clientes de revenda para registrar a tabela de
                    preços por cliente/SKU — um canal separado do preço de
                    licitação.
                  </p>
                  <div style={{ marginTop: 16 }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={onNew}
                    >
                      <Plus aria-hidden="true" />
                      <span>Novo cliente</span>
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          ) : (
            clientes.map((cliente) => {
              const desc = ativoDescriptor(cliente.ativo);
              const active = cliente.id === selectedId;
              return (
                <tr
                  key={cliente.id}
                  className={cn("clk", active && "active-row")}
                  aria-selected={active}
                  onClick={() => onSelect(cliente)}
                  style={active ? { background: "var(--accent-soft)" } : undefined}
                >
                  <td>
                    <div className="cell-stack">
                      <b style={{ fontSize: "13.5px" }}>{cliente.nome}</b>
                    </div>
                  </td>
                  <td>
                    <StatusPill state={desc.state} label={desc.label} />
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
                          onEdit(cliente);
                        }}
                        aria-label="Editar cliente"
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
