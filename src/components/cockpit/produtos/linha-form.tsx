"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, TriangleAlert, X } from "lucide-react";
import { useCreateLinha, useUpdateLinha } from "@/hooks/use-linhas";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ProdutoLinha } from "@/lib/api/types";

const linhaSchema = z.object({
  nome: z.string().trim().min(1, "Informe o nome da linha."),
  descricao: z.string().trim().optional(),
  ativo: z.boolean(),
});
type LinhaValues = z.infer<typeof linhaSchema>;

/**
 * cmp-linha-form — criacao/edicao inline de uma Linha de produto (card padrao).
 * Em modo edicao hidrata a partir de `linha`; em criacao parte de um formulario
 * limpo. Validacao react-hook-form + zod ANTES do submit (nome obrigatorio) —
 * nunca cria registro parcial. Erros do endpoint (ex.: nome duplicado) sao
 * exibidos inline.
 */
export function LinhaForm({
  linha,
  onSuccess,
  onCancel,
}: {
  linha?: ProdutoLinha;
  onSuccess?: (linha: ProdutoLinha) => void;
  onCancel?: () => void;
}) {
  const isEdit = Boolean(linha);
  const createLinha = useCreateLinha();
  const updateLinha = useUpdateLinha();
  const pending = createLinha.isPending || updateLinha.isPending;

  const [apiError, setApiError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<LinhaValues>({
    resolver: zodResolver(linhaSchema),
    defaultValues: {
      nome: linha?.nome ?? "",
      descricao: linha?.descricao ?? "",
      ativo: linha?.ativo ?? true,
    },
  });

  async function onSubmit(values: LinhaValues) {
    setApiError(null);
    const input = {
      nome: values.nome,
      descricao: values.descricao ? values.descricao : null,
      ativo: values.ativo,
    };
    try {
      const saved =
        isEdit && linha
          ? await updateLinha.mutateAsync({ id: linha.id, input })
          : await createLinha.mutateAsync(input);
      onSuccess?.(saved);
    } catch (err) {
      setApiError(
        err instanceof ApiError && err.status === 409
          ? "Já existe uma linha com este nome."
          : err instanceof ApiError && err.status === 400
            ? "Dados inválidos: revise os campos."
            : "Não foi possível salvar a linha. Tente novamente.",
      );
    }
  }

  return (
    <form className="card form-card" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="section-title" style={{ margin: "0 0 16px" }}>
        <h3>{isEdit ? "Editar linha" : "Nova linha"}</h3>
      </div>

      <div className={cn("field", errors.nome && "invalid")}>
        <label htmlFor="linha-nome">Nome</label>
        <input
          id="linha-nome"
          type="text"
          placeholder="ex.: Eletroportáteis"
          aria-invalid={Boolean(errors.nome)}
          {...register("nome")}
        />
        <div className="err-msg">
          <TriangleAlert aria-hidden="true" />
          {errors.nome?.message ?? "Informe o nome da linha."}
        </div>
      </div>

      <div className="field">
        <label htmlFor="linha-descricao">Descrição</label>
        <textarea
          id="linha-descricao"
          rows={3}
          placeholder="Descrição opcional da linha"
          {...register("descricao")}
        />
        <div className="helper">Opcional. Contextualiza a linha para o time.</div>
      </div>

      <label className="chk" style={{ maxWidth: 240 }}>
        <input type="checkbox" {...register("ativo")} />
        <div className="t">Linha ativa</div>
      </label>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{pending ? "Salvando…" : isEdit ? "Salvar alterações" : "Criar linha"}</span>
        </button>
        {onCancel && (
          <button
            className="btn"
            type="button"
            onClick={onCancel}
            disabled={pending}
          >
            <X aria-hidden="true" />
            <span>Cancelar</span>
          </button>
        )}
        {isEdit && !isDirty && !apiError ? (
          <span className="save-note">Sem alterações pendentes</span>
        ) : null}
        {apiError && (
          <span className="save-note err">
            <TriangleAlert aria-hidden="true" />
            {apiError}
          </span>
        )}
      </div>
    </form>
  );
}
