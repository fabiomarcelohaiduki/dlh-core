"use client";

import { useState } from "react";
import { Inbox, Pencil, Plus } from "lucide-react";
import type { RegraDura } from "@/lib/api/types";
import { useDeleteRegra, useTriagemRegras } from "@/hooks/use-triagem-regras";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { TriagemRegrasForm } from "@/components/automacao/triagem-regras-form";
import { WidgetError } from "@/components/cockpit/widget-error";

const TIPO_LABEL: Record<RegraDura["tipo"], string> = {
  fora_de_ramo: "Fora de ramo",
  termo_produto: "Termo de produto",
};

type Editing = { mode: "create" } | { mode: "edit"; regra: RegraDura } | null;

function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: 4 }).map((__, c) => (
            <td key={c}>
              <span
                className="skel skel-line"
                style={{ width: c === 3 ? 120 : `${50 + ((r + c) % 4) * 12}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * RegrasClient — aba Regras. CRUD das regras duras (fora_de_ramo /
 * termo_produto) consumidas deterministicamente pela triagem. Lista as regras
 * (tipo, termo, status ativo) e abre o triagem-regras-form para criar/editar.
 * A remocao usa use-delete-regra com erro inline; todas as mutacoes invalidam
 * a lista no onSuccess (via hooks). Estados loading/error/empty tratados.
 */
export function RegrasClient() {
  const regras = useTriagemRegras();
  const deleteRegra = useDeleteRegra();

  const [editing, setEditing] = useState<Editing>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const items = regras.data?.regras ?? [];
  const loading = regras.isLoading;

  function closeForm() {
    setEditing(null);
    setDeleteError(null);
  }

  async function handleDelete(id: string) {
    setDeleteError(null);
    try {
      await deleteRegra.mutateAsync(id);
      closeForm();
    } catch (err) {
      setDeleteError(
        err instanceof ApiError && err.status === 404
          ? "Esta regra não existe mais."
          : "Não foi possível remover a regra. Tente novamente.",
      );
    }
  }

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Regras</h3>
        {!loading && !regras.isError && <span className="count">{items.length}</span>}
        {!editing && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            style={{ marginLeft: "auto" }}
            onClick={() => setEditing({ mode: "create" })}
          >
            <Plus aria-hidden="true" />
            <span>Nova regra</span>
          </button>
        )}
      </div>

      <p className="helper" style={{ marginTop: 2, marginBottom: 16 }}>
        Regras duras avaliadas deterministicamente pela triagem, antes do veredito
        da IA. As alterações valem na próxima execução da esteira.
      </p>

      {editing && (
        <div style={{ marginBottom: 18 }}>
          <TriagemRegrasForm
            regra={editing.mode === "edit" ? editing.regra : undefined}
            onSuccess={closeForm}
            onCancel={closeForm}
            onDelete={
              editing.mode === "edit"
                ? () => handleDelete(editing.regra.id)
                : undefined
            }
            deleting={deleteRegra.isPending}
            deleteError={deleteError}
          />
        </div>
      )}

      {regras.isError ? (
        <WidgetError
          title="Não foi possível carregar"
          message="Não foi possível carregar as regras. Tente novamente."
          onRetry={() => regras.refetch()}
        />
      ) : (
        <div className="tbl-wrap tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Termo</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows />
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <div className="empty">
                      <Inbox aria-hidden="true" />
                      <h4>Nenhuma regra dura cadastrada.</h4>
                      <p>Crie uma regra para guiar a triagem antes do veredito da IA.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((r) => (
                  <tr key={r.id}>
                    <td>{TIPO_LABEL[r.tipo]}</td>
                    <td>{r.termo}</td>
                    <td>
                      <span className={cn("tag", r.ativo ? "util" : undefined)}>
                        {r.ativo ? "Ativa" : "Inativa"}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setDeleteError(null);
                          setEditing({ mode: "edit", regra: r });
                        }}
                      >
                        <Pencil aria-hidden="true" />
                        <span>Editar</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
