"use client";

import { useMemo, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, TriangleAlert, X } from "lucide-react";
import { useCreateSku, useUpdateSku } from "@/hooks/use-skus";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { AtributoSchema, ProdutoSku, SkuTipoOrigem } from "@/lib/api/types";

const optionalNumber = z.preprocess(
  (v) =>
    v === "" || v === null || (typeof v === "number" && Number.isNaN(v))
      ? undefined
      : v,
  z.number({ invalid_type_error: "Informe um número." }).optional(),
);

/**
 * Constroi o sub-schema zod dos atributos definidos no Produto que o SKU
 * preenche: tipo texto/numero/booleano + obrigatorio. O SKU e quem informa os
 * VALORES; o backend exige os obrigatorios do schema do Produto.
 */
function buildAtributosSchema(schema: AtributoSchema[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const a of schema) {
    if (a.tipo === "numero") {
      shape[a.chave] = z.preprocess(
        (v) =>
          v === "" || v === null || (typeof v === "number" && Number.isNaN(v))
            ? undefined
            : v,
        a.obrigatorio
          ? z.number({
              required_error: "Campo obrigatório.",
              invalid_type_error: "Informe um número.",
            })
          : z.number({ invalid_type_error: "Informe um número." }).optional(),
      );
    } else if (a.tipo === "booleano") {
      shape[a.chave] = z.boolean().optional();
    } else {
      shape[a.chave] = a.obrigatorio
        ? z.string().trim().min(1, "Campo obrigatório.")
        : z.string().trim().optional();
    }
  }
  return z.object(shape);
}

type SkuValues = {
  codigo_sku: string;
  tipo_origem: SkuTipoOrigem;
  atributos: Record<string, string | number | boolean | undefined>;
  acabamento?: string;
  peso_gr?: number;
  tolerancia_pct?: number;
  diretriz_producao?: string;
  tempo_producao?: number;
};

/**
 * cmp-sku-form — cria/edita um SKU (produto_skus). Expoe tipo_origem
 * (fabricado/comprado); os campos diretriz_producao e tempo_producao SO
 * aparecem (e SO sao enviados) quando fabricado — o backend bloqueia
 * incoerencias de tipo_origem (400). Em edicao o tipo_origem fica travado para
 * evitar inverter origem de um SKU ja com BOM/custo. Os ATRIBUTOS definidos no
 * Produto sao preenchidos POR SKU; obrigatorios sao exigidos aqui.
 * Validacao react-hook-form + zod inline.
 */
export function SkuForm({
  produtoId,
  schema,
  produtoAtributos,
  sku,
  onSuccess,
  onCancel,
}: {
  produtoId: string;
  schema: AtributoSchema[];
  produtoAtributos?: Record<string, unknown>;
  sku?: ProdutoSku;
  onSuccess?: (sku: ProdutoSku) => void;
  onCancel?: () => void;
}) {
  const isEdit = Boolean(sku);
  const createSku = useCreateSku();
  const updateSku = useUpdateSku();
  const pending = createSku.isPending || updateSku.isPending;

  const [apiError, setApiError] = useState<string | null>(null);

  const formSchema = useMemo(
    () =>
      z.object({
        codigo_sku: z.string().trim().min(1, "Informe o código do SKU."),
        tipo_origem: z.enum(["fabricado", "comprado"]),
        atributos: buildAtributosSchema(schema),
        acabamento: z.string().trim().optional(),
        peso_gr: optionalNumber,
        tolerancia_pct: optionalNumber,
        diretriz_producao: z.string().trim().optional(),
        tempo_producao: optionalNumber,
      }),
    [schema],
  );

  const defaultAtributos = useMemo(() => {
    const base: Record<string, string | number | boolean | undefined> = {};
    for (const a of schema) {
      // Em edicao usa o valor proprio do SKU. Ao criar, os atributos de origem
      // 'linha' HERDAM o valor ja informado no Produto (sobrescrivivel por SKU);
      // os proprios do Produto comecam vazios.
      let current = sku?.atributos?.[a.chave];
      if (current == null && a.origem === "linha") {
        current = produtoAtributos?.[a.chave];
      }
      if (a.tipo === "booleano") {
        base[a.chave] = Boolean(current);
      } else if (a.tipo === "numero") {
        base[a.chave] =
          typeof current === "number" ? current : (current as string) ?? "";
      } else {
        base[a.chave] = current != null ? String(current) : "";
      }
    }
    return base;
  }, [schema, sku, produtoAtributos]);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<SkuValues>({
    resolver: zodResolver(formSchema) as Resolver<SkuValues>,
    defaultValues: {
      codigo_sku: sku?.codigo_sku ?? "",
      tipo_origem: sku?.tipo_origem ?? "fabricado",
      atributos: defaultAtributos,
      acabamento: sku?.acabamento ?? "",
      peso_gr: sku?.peso_gr ?? undefined,
      tolerancia_pct: sku?.tolerancia_pct ?? undefined,
      diretriz_producao: sku?.diretriz_producao ?? "",
      tempo_producao: sku?.tempo_producao ?? undefined,
    },
  });

  const tipoOrigem = watch("tipo_origem") as SkuTipoOrigem;
  const fabricado = tipoOrigem === "fabricado";

  const atributoErrors = errors.atributos as
    | Record<string, { message?: string } | undefined>
    | undefined;

  async function onSubmit(values: SkuValues) {
    setApiError(null);

    // Monta o JSONB de atributos so com valores informados, conforme o schema
    // mesclado (Linha + Produto); o backend rejeita chave fora do schema.
    const atributos: Record<string, unknown> = {};
    for (const a of schema) {
      const v = values.atributos?.[a.chave];
      if (a.tipo === "booleano") {
        atributos[a.chave] = Boolean(v);
      } else if (a.tipo === "numero") {
        if (typeof v === "number" && !Number.isNaN(v)) atributos[a.chave] = v;
      } else if (typeof v === "string" && v.trim() !== "") {
        atributos[a.chave] = v.trim();
      }
    }

    const base = {
      codigo_sku: values.codigo_sku,
      tipo_origem: values.tipo_origem,
      atributos,
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

      {schema.length > 0 && (
        <>
          <div className="section-title" style={{ margin: "20px 0 13px" }}>
            <h3>Atributos do produto</h3>
          </div>
          <div className="grid-fields">
            {schema.map((a) => {
              const fieldError = atributoErrors?.[a.chave]?.message;
              if (a.tipo === "booleano") {
                return (
                  <label
                    key={a.chave}
                    className="chk"
                    style={{ alignSelf: "end", height: 40 }}
                  >
                    <input type="checkbox" {...register(`atributos.${a.chave}`)} />
                    <div className="t">
                      {a.chave}
                      {a.obrigatorio ? " *" : ""}
                      {a.origem === "linha" ? (
                        <span className="tag" style={{ marginLeft: 6 }}>
                          Herdado
                        </span>
                      ) : null}
                    </div>
                  </label>
                );
              }
              return (
                <div key={a.chave} className={cn("field", fieldError && "invalid")}>
                  <label htmlFor={`sku-attr-${a.chave}`}>
                    {a.chave}
                    {a.obrigatorio ? " *" : ""}
                    {a.origem === "linha" ? (
                      <span className="tag" style={{ marginLeft: 6 }}>
                        Herdado
                      </span>
                    ) : null}
                  </label>
                  <input
                    id={`sku-attr-${a.chave}`}
                    type={a.tipo === "numero" ? "number" : "text"}
                    step={a.tipo === "numero" ? "any" : undefined}
                    aria-invalid={Boolean(fieldError)}
                    {...register(
                      `atributos.${a.chave}`,
                      a.tipo === "numero" ? { valueAsNumber: true } : {},
                    )}
                  />
                  <div className="err-msg">
                    <TriangleAlert aria-hidden="true" />
                    {fieldError ?? "Campo obrigatório."}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

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
