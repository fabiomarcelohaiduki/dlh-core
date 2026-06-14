"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, Trash2, TriangleAlert, X } from "lucide-react";
import { useCreateInsumo, useUpdateInsumo } from "@/hooks/use-insumos";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Insumo, InsumoCategoria } from "@/lib/api/types";

const CATEGORIAS: { value: InsumoCategoria; label: string }[] = [
  { value: "MP", label: "Matéria-prima" },
  { value: "embalagem", label: "Embalagem" },
  { value: "insumo", label: "Insumo" },
];

const insumoSchema = z.object({
  nome: z.string().trim().min(1, "Informe o nome do material."),
  categoria: z.enum(["MP", "embalagem", "insumo"]),
  unidade: z.string().trim().min(1, "Informe a unidade (ex.: kg, un, m)."),
  ativo: z.boolean(),
});
type InsumoValues = z.infer<typeof insumoSchema>;

/**
 * cmp-insumo-form — cria/edita um insumo (insumos). Categoria restrita a
 * MP/embalagem/insumo, unidade textual livre (kg, un, m...). O toggle `ativo`
 * so aparece na edicao: insumo inativo deixa de ser selecionavel em novas
 * composicoes (regra aplicada no composicao-editor). Validacao zod inline.
 */
export function InsumoForm({
  insumo,
  onSuccess,
  onCancel,
  onDelete,
  deleting = false,
  deleteError,
}: {
  insumo?: Insumo;
  onSuccess?: (insumo: Insumo) => void;
  onCancel?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  deleteError?: string | null;
}) {
  const isEdit = Boolean(insumo);
  const createInsumo = useCreateInsumo();
  const updateInsumo = useUpdateInsumo();
  const pending = createInsumo.isPending || updateInsumo.isPending;

  const [apiError, setApiError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<InsumoValues>({
    resolver: zodResolver(insumoSchema),
    defaultValues: {
      nome: insumo?.nome ?? "",
      categoria: insumo?.categoria ?? "MP",
      unidade: insumo?.unidade ?? "",
      ativo: insumo?.ativo ?? true,
    },
  });

  const ativo = watch("ativo");

  async function onSubmit(values: InsumoValues) {
    setApiError(null);
    const input = {
      nome: values.nome.trim(),
      categoria: values.categoria,
      unidade: values.unidade.trim(),
      ativo: values.ativo,
    };
    try {
      const saved =
        isEdit && insumo
          ? await updateInsumo.mutateAsync({ id: insumo.id, input })
          : await createInsumo.mutateAsync(input);
      onSuccess?.(saved);
    } catch (err) {
      setApiError(
        err instanceof ApiError && err.status === 409
          ? "Já existe um material com este nome."
          : err instanceof ApiError && err.status === 400
            ? "Dados inválidos: revise os campos do material."
            : "Não foi possível salvar o material. Tente novamente.",
      );
    }
  }

  return (
    <form className="card form-card--wide" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="section-title" style={{ margin: "0 0 16px" }}>
        <h3>{isEdit ? "Editar material" : "Novo material"}</h3>
      </div>

      <div className="grid-fields">
        <div className={cn("field", errors.nome && "invalid")}>
          <label htmlFor="insumo-nome">Nome</label>
          <input
            id="insumo-nome"
            type="text"
            placeholder="ex.: Resina PET grau garrafa"
            aria-invalid={Boolean(errors.nome)}
            {...register("nome")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.nome?.message ?? "Informe o nome do material."}
          </div>
        </div>

        <div className="field">
          <label htmlFor="insumo-categoria">Categoria</label>
          <select id="insumo-categoria" {...register("categoria")}>
            {CATEGORIAS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className={cn("field", errors.unidade && "invalid")}>
          <label htmlFor="insumo-unidade">Unidade</label>
          <input
            id="insumo-unidade"
            type="text"
            placeholder="ex.: kg, un, m, L"
            aria-invalid={Boolean(errors.unidade)}
            {...register("unidade")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.unidade?.message ?? "Informe a unidade."}
          </div>
        </div>

        {isEdit && (
          <label className="chk" style={{ alignSelf: "end" }}>
            <input
              type="checkbox"
              checked={ativo}
              onChange={(e) =>
                setValue("ativo", e.target.checked, { shouldDirty: true })
              }
            />
            <div className="t">Ativo</div>
          </label>
        )}
      </div>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{pending ? "Salvando…" : isEdit ? "Salvar material" : "Criar material"}</span>
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
                <span>Excluir material</span>
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
