"use client";

import { useState } from "react";
import { Layers, Loader2, Pencil, Plus, TriangleAlert, Trash2, X } from "lucide-react";
import { useDeleteLinha } from "@/hooks/use-linhas";
import { ApiError } from "@/lib/api/client";
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
 * da Linha. A linha SELECIONADA exibe as acoes (Editar/Excluir) inline — a
 * identidade da Linha vive so aqui, o detalhe a direita nao a repete.
 * Estados travados loading (skeleton) / error / empty (com CTA).
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
  onDeleted,
}: {
  linhas: ProdutoLinha[];
  loading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  selectedId?: string | null;
  onSelect: (linha: ProdutoLinha) => void;
  onNew: () => void;
  onEdit: (linha: ProdutoLinha) => void;
  onDeleted: () => void;
}) {
  const deleteLinha = useDeleteLinha();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function onConfirmDelete(linha: ProdutoLinha) {
    setErro(null);
    try {
      await deleteLinha.mutateAsync(linha.id);
      setConfirmingId(null);
      onDeleted();
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 409
          ? "Linha possui produtos vinculados. Remova os Produtos antes de excluir."
          : "Não foi possível excluir a linha. Tente novamente.",
      );
    }
  }

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
                    {active && erro && confirmingId === l.id ? (
                      <div
                        className="err-msg"
                        style={{ display: "flex", marginTop: 8 }}
                      >
                        <TriangleAlert aria-hidden="true" />
                        {erro}
                      </div>
                    ) : null}
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
                      {active ? (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            display: "flex",
                            gap: 6,
                          }}
                        >
                          <button
                            type="button"
                            className="btn btn-sm btn-icon"
                            onClick={() => onEdit(l)}
                            aria-label="Editar linha"
                            title="Editar"
                          >
                            <Pencil aria-hidden="true" />
                          </button>
                          {confirmingId === l.id ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon"
                                style={{ color: "var(--err)" }}
                                onClick={() => onConfirmDelete(l)}
                                disabled={deleteLinha.isPending}
                                aria-label="Confirmar exclusão"
                                title="Confirmar exclusão"
                              >
                                {deleteLinha.isPending ? (
                                  <Loader2 className="spin" aria-hidden="true" />
                                ) : (
                                  <Trash2 aria-hidden="true" />
                                )}
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon"
                                onClick={() => {
                                  setConfirmingId(null);
                                  setErro(null);
                                }}
                                disabled={deleteLinha.isPending}
                                aria-label="Cancelar"
                                title="Cancelar"
                              >
                                <X aria-hidden="true" />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm btn-icon"
                              onClick={() => {
                                setConfirmingId(l.id);
                                setErro(null);
                              }}
                              aria-label="Excluir linha"
                              title="Excluir"
                            >
                              <Trash2 aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      ) : null}
                      <StatusPill state={desc.state} label={desc.label} iconOnly />
                    </div>
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
