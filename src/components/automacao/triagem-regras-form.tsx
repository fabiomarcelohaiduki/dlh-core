"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, Trash2, TriangleAlert, X } from "lucide-react";
import {
  useCreateRegra,
  useUpdateRegra,
} from "@/hooks/use-triagem-regras";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { RegraDura } from "@/lib/api/types";

const TIPOS: { value: RegraDura["tipo"]; label: string; helper: string }[] = [
  {
    value: "fora_de_ramo",
    label: "Fora de ramo",
    helper: "Descarta direto quando o termo aparece (objeto irrelevante ao ramo).",
  },
  {
    value: "termo_produto",
    label: "Termo de produto",
    helper: "Marca como útil quando o termo de produto aparece no objeto.",
  },
];

const regraSchema = z.object({
  tipo: z.enum(["fora_de_ramo", "termo_produto"]),
  termo: z.string().trim().min(1, "Informe o termo."),
  ativo: z.boolean(),
});
type RegraValues = z.infer<typeof regraSchema>;

/**
 * cmp-triagem-regras-form — cria/edita uma regra dura (fora_de_ramo /
 * termo_produto) consumida deterministicamente pela triagem. Em criacao parte
 * de um formulario limpo; em edicao hidrata a partir de `regra` e trava o tipo
 * (o endpoint PUT so altera termo/ativo). Validacao react-hook-form + zod ANTES
 * do submit (termo obrigatorio). Termo duplicado (409) e demais falhas do
 * endpoint sao exibidos inline. A remocao (modo edicao) e delegada ao client
 * via onDelete, com confirmacao em dois passos.
 */
export function TriagemRegrasForm({
  regra,
  onSuccess,
  onCancel,
  onDelete,
  deleting = false,
  deleteError,
}: {
  regra?: RegraDura;
  onSuccess?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  deleteError?: string | null;
}) {
  const isEdit = Boolean(regra);
  const createRegra = useCreateRegra();
  const updateRegra = useUpdateRegra();
  const pending = createRegra.isPending || updateRegra.isPending;

  const [apiError, setApiError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<RegraValues>({
    resolver: zodResolver(regraSchema),
    defaultValues: {
      tipo: regra?.tipo ?? "fora_de_ramo",
      termo: regra?.termo ?? "",
      ativo: regra?.ativo ?? true,
    },
  });

  const ativo = watch("ativo");
  const tipo = watch("tipo");
  const tipoHelper = TIPOS.find((t) => t.value === tipo)?.helper;

  async function onSubmit(values: RegraValues) {
    setApiError(null);
    try {
      if (isEdit && regra) {
        await updateRegra.mutateAsync({
          id: regra.id,
          termo: values.termo.trim(),
          ativo: values.ativo,
        });
      } else {
        await createRegra.mutateAsync({
          tipo: values.tipo,
          termo: values.termo.trim(),
          ativo: values.ativo,
        });
      }
      onSuccess?.();
    } catch (err) {
      setApiError(
        err instanceof ApiError && err.status === 409
          ? "Já existe uma regra com este termo."
          : err instanceof ApiError && err.status === 400
            ? "Dados inválidos: revise os campos da regra."
            : "Não foi possível salvar a regra. Tente novamente.",
      );
    }
  }

  return (
    <form className="card form-card--wide" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="section-title" style={{ margin: "0 0 16px" }}>
        <h3>{isEdit ? "Editar regra" : "Nova regra"}</h3>
      </div>

      <div className="grid-fields">
        <div className="field">
          <label htmlFor="regra-tipo">Tipo</label>
          <select id="regra-tipo" disabled={isEdit} {...register("tipo")}>
            {TIPOS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="helper">
            {isEdit
              ? "O tipo não pode ser alterado depois de criada a regra."
              : tipoHelper}
          </div>
        </div>

        <div className={cn("field", errors.termo && "invalid")}>
          <label htmlFor="regra-termo">Termo</label>
          <input
            id="regra-termo"
            type="text"
            placeholder="ex.: medicamento"
            aria-invalid={Boolean(errors.termo)}
            {...register("termo")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.termo?.message ?? "Informe o termo."}
          </div>
        </div>

        <label className="chk" style={{ alignSelf: "end" }}>
          <input
            type="checkbox"
            checked={ativo}
            onChange={(e) => setValue("ativo", e.target.checked, { shouldDirty: true })}
          />
          <div className="t">Regra ativa</div>
        </label>
      </div>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{pending ? "Salvando…" : isEdit ? "Salvar regra" : "Criar regra"}</span>
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
                <span>Excluir regra</span>
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
