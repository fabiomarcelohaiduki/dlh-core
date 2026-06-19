"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  BookOpen,
  Check,
  Inbox,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useConhecimentos,
  useCreateConhecimento,
  useDeleteConhecimento,
  useUpdateConhecimento,
} from "@/hooks/use-conhecimentos";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Conhecimento } from "@/lib/api/types";
import { WidgetError } from "@/components/cockpit/widget-error";

const conhecimentoSchema = z.object({
  titulo: z.string().trim().min(1, "Informe o título."),
  conteudo: z.string().trim().min(1, "Informe o conteúdo."),
  ativo: z.boolean(),
  ordem: z.coerce.number().int("Ordem deve ser inteira.").min(0, "Ordem não pode ser negativa."),
});
type ConhecimentoValues = z.infer<typeof conhecimentoSchema>;

type Editing = { mode: "create" } | { mode: "edit"; item: Conhecimento } | null;

/** Formulario inline de criacao/edicao de um item de conhecimento. */
function ConhecimentoForm({
  setor,
  item,
  onSuccess,
  onCancel,
  onDelete,
  deleting = false,
  deleteError,
}: {
  setor: string;
  item?: Conhecimento;
  onSuccess?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  deleteError?: string | null;
}) {
  const isEdit = Boolean(item);
  const create = useCreateConhecimento(setor);
  const update = useUpdateConhecimento(setor);
  const pending = create.isPending || update.isPending;

  const [apiError, setApiError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<ConhecimentoValues>({
    resolver: zodResolver(conhecimentoSchema),
    defaultValues: {
      titulo: item?.titulo ?? "",
      conteudo: item?.conteudo ?? "",
      ativo: item?.ativo ?? true,
      ordem: item?.ordem ?? 0,
    },
  });

  const ativo = watch("ativo");

  async function onSubmit(values: ConhecimentoValues) {
    setApiError(null);
    try {
      if (isEdit && item) {
        await update.mutateAsync({
          id: item.id,
          titulo: values.titulo.trim(),
          conteudo: values.conteudo.trim(),
          ativo: values.ativo,
          ordem: values.ordem,
        });
      } else {
        await create.mutateAsync({
          setor,
          titulo: values.titulo.trim(),
          conteudo: values.conteudo.trim(),
          ativo: values.ativo,
          ordem: values.ordem,
        });
      }
      onSuccess?.();
    } catch (err) {
      setApiError(
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? "Dados inválidos: revise os campos."
          : "Não foi possível salvar o conhecimento. Tente novamente.",
      );
    }
  }

  return (
    <form className="card form-card--wide" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="section-title" style={{ margin: "0 0 16px" }}>
        <h3>{isEdit ? "Editar conhecimento" : "Novo conhecimento"}</h3>
      </div>

      <div className={cn("field", errors.titulo && "invalid")}>
        <label htmlFor="conhecimento-titulo">Título</label>
        <input
          id="conhecimento-titulo"
          type="text"
          placeholder="ex.: Critérios de participação por modalidade"
          aria-invalid={Boolean(errors.titulo)}
          {...register("titulo")}
        />
        <div className="err-msg">
          <TriangleAlert aria-hidden="true" />
          {errors.titulo?.message ?? "Informe o título."}
        </div>
      </div>

      <div className={cn("field", errors.conteudo && "invalid")}>
        <label htmlFor="conhecimento-conteudo">Conteúdo</label>
        <textarea
          id="conhecimento-conteudo"
          rows={8}
          placeholder="Regras, vocabulário e critérios de domínio que o subagente deve seguir…"
          aria-invalid={Boolean(errors.conteudo)}
          {...register("conteudo")}
        />
        <div className="err-msg">
          <TriangleAlert aria-hidden="true" />
          {errors.conteudo?.message ?? "Informe o conteúdo."}
        </div>
      </div>

      <div className="grid-fields">
        <div className={cn("field", errors.ordem && "invalid")}>
          <label htmlFor="conhecimento-ordem">Ordem</label>
          <input
            id="conhecimento-ordem"
            type="number"
            min={0}
            aria-invalid={Boolean(errors.ordem)}
            {...register("ordem")}
          />
          <div className="helper">Define a ordem de entrega na fila (menor primeiro).</div>
        </div>

        <label className="chk" style={{ alignSelf: "end" }}>
          <input
            type="checkbox"
            checked={ativo}
            onChange={(e) => setValue("ativo", e.target.checked, { shouldDirty: true })}
          />
          <div className="t">Conhecimento ativo</div>
        </label>
      </div>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{pending ? "Salvando…" : isEdit ? "Salvar conhecimento" : "Criar conhecimento"}</span>
        </button>
        {onCancel && (
          <button className="btn" type="button" onClick={onCancel} disabled={pending}>
            <X aria-hidden="true" />
            <span>Cancelar</span>
          </button>
        )}
        {apiError && (
          <span className="save-note err">
            <TriangleAlert aria-hidden="true" />
            {apiError}
          </span>
        )}
        {isEdit && onDelete && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {confirmingDelete ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ color: "var(--err)" }}
                  onClick={onDelete}
                  disabled={deleting}
                >
                  {deleting ? (
                    <Loader2 className="spin" aria-hidden="true" />
                  ) : (
                    <Trash2 aria-hidden="true" />
                  )}
                  <span>Confirmar exclusão</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                >
                  <X aria-hidden="true" />
                  <span>Cancelar</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirmingDelete(true)}
                disabled={pending}
              >
                <Trash2 aria-hidden="true" />
                <span>Excluir conhecimento</span>
              </button>
            )}
          </div>
        )}
      </div>
      {deleteError && (
        <div className="err-msg" style={{ display: "flex", marginTop: 14 }}>
          <TriangleAlert aria-hidden="true" />
          {deleteError}
        </div>
      )}
    </form>
  );
}

/**
 * cmp-conhecimentos-manager — base de conhecimento de dominio do subagente,
 * generica por setor e entregue pela FILA. Lista os itens (titulo, ordem,
 * status, versao) e abre o formulario inline para criar/editar/excluir. Todas
 * as mutacoes invalidam a lista no onSuccess (via hooks). Estados
 * loading/error/empty tratados. Conteudo de dominio, nunca segredo.
 */
export function ConhecimentosManager({ setor = "licitacao" }: { setor?: string }) {
  const conhecimentos = useConhecimentos(setor);
  const remove = useDeleteConhecimento(setor);

  const [editing, setEditing] = useState<Editing>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const items = conhecimentos.data ?? [];
  const loading = conhecimentos.isLoading;

  function closeForm() {
    setEditing(null);
    setDeleteError(null);
  }

  async function handleDelete(id: string) {
    setDeleteError(null);
    try {
      await remove.mutateAsync(id);
      closeForm();
    } catch (err) {
      setDeleteError(
        err instanceof ApiError && err.status === 404
          ? "Este conhecimento não existe mais."
          : "Não foi possível remover o conhecimento. Tente novamente.",
      );
    }
  }

  return (
    <div className="card form-card form-card--wide">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>
          <BookOpen aria-hidden="true" />
          Base de conhecimento
        </h3>
        {!loading && !conhecimentos.isError && <span className="count">{items.length}</span>}
        {!editing && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            style={{ marginLeft: "auto" }}
            onClick={() => setEditing({ mode: "create" })}
          >
            <Plus aria-hidden="true" />
            <span>Novo conhecimento</span>
          </button>
        )}
      </div>

      <p className="helper" style={{ marginTop: 2, marginBottom: 16 }}>
        Conhecimento de domínio entregue ao subagente pela fila. Conteúdo de
        regras, vocabulário e critérios. Cada alteração incrementa a versão.
      </p>

      {editing && (
        <div style={{ marginBottom: 18 }}>
          <ConhecimentoForm
            setor={setor}
            item={editing.mode === "edit" ? editing.item : undefined}
            onSuccess={closeForm}
            onCancel={closeForm}
            onDelete={
              editing.mode === "edit" ? () => handleDelete(editing.item.id) : undefined
            }
            deleting={remove.isPending}
            deleteError={deleteError}
          />
        </div>
      )}

      {conhecimentos.isError ? (
        <WidgetError
          title="Não foi possível carregar"
          message="Não foi possível carregar a base de conhecimento. Tente novamente."
          onRetry={() => conhecimentos.refetch()}
        />
      ) : (
        <div className="tbl-wrap tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>Ordem</th>
                <th>Título</th>
                <th>Status</th>
                <th>Versão</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5}>
                    <div className="helper" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Loader2 className="spin" aria-hidden="true" />
                      <span>Carregando base de conhecimento…</span>
                    </div>
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">
                      <Inbox aria-hidden="true" />
                      <h4>Nenhum conhecimento cadastrado.</h4>
                      <p>Cadastre o conhecimento de domínio que o subagente deve seguir.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((c) => (
                  <tr key={c.id}>
                    <td>{c.ordem}</td>
                    <td>{c.titulo}</td>
                    <td>
                      <span className={cn("tag", c.ativo ? "util" : undefined)}>
                        {c.ativo ? "Ativo" : "Inativo"}
                      </span>
                    </td>
                    <td>v{c.versao}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setDeleteError(null);
                          setEditing({ mode: "edit", item: c });
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
    </div>
  );
}
