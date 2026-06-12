"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, TriangleAlert, X } from "lucide-react";
import { useCreateSku, useUpdateSku } from "@/hooks/use-skus";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ProdutoSku, SkuTipoOrigem } from "@/lib/api/types";

const optionalNumber = z.preprocess(
  (v) =>
    v === "" || v === null || (typeof v === "number" && Number.isNaN(v))
      ? undefined
      : v,
  z.number({ invalid_type_error: "Informe um número." }).optional(),
);

const skuSchema = z.object({
  codigo_sku: z.string().trim().min(1, "Informe o código do SKU."),
  tipo_origem: z.enum(["fabricado", "comprado"]),
  acabamento: z.string().trim().optional(),
  peso_gr: optionalNumber,
  tolerancia_pct: optionalNumber,
  diretriz_producao: z.string().trim().optional(),
  tempo_producao: optionalNumber,
});
type SkuValues = z.infer<typeof skuSchema>;

/**
 * cmp-sku-form — cria/edita um SKU (produto_skus). Expoe tipo_origem
 * (fabricado/comprado); os campos diretriz_producao e tempo_producao SO
 * aparecem (e SO sao enviados) quando fabricado — o backend bloqueia
 * incoerencias de tipo_origem (400). Em edicao o tipo_origem fica travado para
 * evitar inverter origem de um SKU ja com BOM/custo. Validacao zod inline.
 */
export function SkuForm({
  produtoId,
  sku,
  onSuccess,
  onCancel,
}: {
  produtoId: string;
  sku?: ProdutoSku;
  onSuccess?: (sku: ProdutoSku) => void;
  onCancel?: () => void;
}) {
  const isEdit = Boolean(sku);
  const createSku = useCreateSku();
  const updateSku = useUpdateSku();
  const pending = createSku.isPending || updateSku.isPending;

  const [apiError, setApiError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<SkuValues>({
    resolver: zodResolver(skuSchema),
    defaultValues: {
      codigo_sku: sku?.codigo_sku ?? "",
      tipo_origem: sku?.tipo_origem ?? "fabricado",
      acabamento: sku?.acabamento ?? "",
      peso_gr: sku?.peso_gr ?? undefined,
      tolerancia_pct: sku?.tolerancia_pct ?? undefined,
      diretriz_producao: sku?.diretriz_producao ?? "",
      tempo_producao: sku?.tempo_producao ?? undefined,
    },
  });

  const tipoOrigem = watch("tipo_origem") as SkuTipoOrigem;
  const fabricado = tipoOrigem === "fabricado";

  async function onSubmit(values: SkuValues) {
    setApiError(null);

    const base = {
      codigo_sku: values.codigo_sku,
      tipo_origem: values.tipo_origem,
      acabamento: values.acabamento?.trim() ? values.acabamento.trim() : null,
      peso_gr: values.peso_gr ?? null,
      tolerancia_pct: values.tolerancia_pct ?? null,
    };

    // diretriz/tempo so existem para SKU fabricado (coerencia de tipo_origem).
    const input = fabricado
      ? {
          ...base,
          diretriz_producao: values.diretriz_producao?.trim()
            ? values.diretriz_producao.trim()
            : null,
          tempo_producao: values.tempo_producao ?? null,
        }
      : base;

    try {
      const saved =
        isEdit && sku
          ? await updateSku.mutateAsync({ skuId: sku.id, input })
          : await createSku.mutateAsync({ produtoId, input });
      onSuccess?.(saved);
    } catch (err) {
      setApiError(
        err instanceof ApiError && err.status === 409
          ? "Já existe um SKU com este código."
          : err instanceof ApiError && err.status === 400
            ? "Dados inválidos: revise os campos do SKU."
            : "Não foi possível salvar o SKU. Tente novamente.",
      );
    }
  }

  return (
    <form className="card form-card--wide" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="section-title" style={{ margin: "0 0 16px" }}>
        <h3>{isEdit ? "Editar SKU" : "Novo SKU"}</h3>
      </div>

      <div className="grid-fields">
        <div className={cn("field", errors.codigo_sku && "invalid")}>
          <label htmlFor="sku-codigo">Código do SKU</label>
          <input
            id="sku-codigo"
            type="text"
            placeholder="ex.: LIQ-600-PRE"
            aria-invalid={Boolean(errors.codigo_sku)}
            {...register("codigo_sku")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.codigo_sku?.message ?? "Informe o código do SKU."}
          </div>
        </div>

        <div className="field">
          <label htmlFor="sku-tipo">Origem</label>
          <select id="sku-tipo" disabled={isEdit} {...register("tipo_origem")}>
            <option value="fabricado">Fabricado (BOM)</option>
            <option value="comprado">Comprado (aquisição)</option>
          </select>
          <div className="helper">
            {isEdit
              ? "A origem não muda após a criação."
              : fabricado
                ? "Custo via composição (BOM) + mão de obra."
                : "Custo via custo de aquisição vigente."}
          </div>
        </div>

        <div className="field">
          <label htmlFor="sku-acabamento">Acabamento</label>
          <input
            id="sku-acabamento"
            type="text"
            placeholder="Opcional"
            {...register("acabamento")}
          />
        </div>

        <div className="field">
          <label htmlFor="sku-peso">Peso (g)</label>
          <input
            id="sku-peso"
            type="number"
            step="any"
            placeholder="Opcional"
            {...register("peso_gr", { valueAsNumber: true })}
          />
        </div>

        <div className="field">
          <label htmlFor="sku-tol">Tolerância (%)</label>
          <input
            id="sku-tol"
            type="number"
            step="any"
            placeholder="Opcional"
            {...register("tolerancia_pct", { valueAsNumber: true })}
          />
        </div>
      </div>

      {fabricado && (
        <>
          <div className="section-title" style={{ margin: "20px 0 13px" }}>
            <h3>Produção (somente fabricado)</h3>
          </div>
          <div className="field">
            <label htmlFor="sku-diretriz">Diretriz de produção</label>
            <textarea
              id="sku-diretriz"
              rows={3}
              placeholder="Texto indexado para a cotação da Lia (opcional)."
              {...register("diretriz_producao")}
            />
            <div className="helper">
              Ao salvar, o texto é reindexado semanticamente; esvaziar remove o índice.
            </div>
          </div>
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="sku-tempo">Tempo de produção (h)</label>
            <input
              id="sku-tempo"
              type="number"
              step="any"
              placeholder="Opcional"
              {...register("tempo_producao", { valueAsNumber: true })}
            />
          </div>
        </>
      )}

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{pending ? "Salvando…" : isEdit ? "Salvar SKU" : "Criar SKU"}</span>
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
      </div>
    </form>
  );
}
