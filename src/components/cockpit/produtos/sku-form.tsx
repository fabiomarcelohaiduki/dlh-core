"use client";

import { useMemo, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, Trash2, TriangleAlert, X } from "lucide-react";
import { useCreateSku, useUpdateSku } from "@/hooks/use-skus";
import { useParametros } from "@/hooks/use-parametros";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type {
  AtributoSchema,
  ProdutoSku,
  SkuTipoOrigem,
  SkuUnidadeTempo,
} from "@/lib/api/types";

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
  diretriz_producao?: string;
  tamanho_lote?: number;
  tempo_lote?: number;
  unidade_tempo: SkuUnidadeTempo;
};

/**
 * cmp-sku-form — cria/edita um SKU (produto_skus). Expoe tipo_origem
 * (fabricado/comprado); os campos diretriz_producao e lote de producao
 * (tamanho/tempo/unidade) SO aparecem (e SO sao enviados) quando fabricado — o
 * backend bloqueia incoerencias de tipo_origem (400). O tempo por unidade e
 * DERIVADO do lote (preview read-only; o backend recalcula). Em edicao o
 * tipo_origem fica travado para evitar inverter origem de um SKU ja com
 * BOM/custo. Os ATRIBUTOS definidos no Produto sao preenchidos POR SKU;
 * obrigatorios sao exigidos aqui. Validacao react-hook-form + zod inline.
 */
export function SkuForm({
  produtoId,
  schema,
  produtoAtributos,
  sku,
  onSuccess,
  onCancel,
  onDelete,
  deleting,
}: {
  produtoId: string;
  schema: AtributoSchema[];
  produtoAtributos?: Record<string, unknown>;
  sku?: ProdutoSku;
  onSuccess?: (sku: ProdutoSku) => void;
  onCancel?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const isEdit = Boolean(sku);
  const createSku = useCreateSku();
  const updateSku = useUpdateSku();
  const pending = createSku.isPending || updateSku.isPending;

  const [apiError, setApiError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const formSchema = useMemo(
    () =>
      z.object({
        codigo_sku: z.string().trim().min(1, "Informe o código do SKU."),
        tipo_origem: z.enum(["fabricado", "comprado"]),
        atributos: buildAtributosSchema(schema),
        diretriz_producao: z.string().trim().optional(),
        tamanho_lote: optionalNumber,
        tempo_lote: optionalNumber,
        unidade_tempo: z.enum(["hora", "dia"]),
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
      diretriz_producao: sku?.diretriz_producao ?? "",
      tamanho_lote: sku?.tamanho_lote ?? undefined,
      tempo_lote: sku?.tempo_lote ?? undefined,
      unidade_tempo: sku?.unidade_tempo ?? "hora",
    },
  });

  const tipoOrigem = watch("tipo_origem") as SkuTipoOrigem;
  const fabricado = tipoOrigem === "fabricado";

  // Jornada (horas/dia) global, p/ converter lote em "dia" no preview.
  const globalParametros = useParametros({ nivel: "global", escopo_id: null });
  const horasPorDia = globalParametros.data?.items?.[0]?.horas_por_dia ?? 8;

  // Preview read-only do tempo por unidade (mesma formula do backend):
  // tempo_lote * fator(unidade) / tamanho_lote. O backend e a fonte da verdade.
  const tamanhoLoteW = watch("tamanho_lote");
  const tempoLoteW = watch("tempo_lote");
  const unidadeTempoW = watch("unidade_tempo");
  const tempoPorUnidade =
    typeof tamanhoLoteW === "number" && tamanhoLoteW > 0 &&
    typeof tempoLoteW === "number" && Number.isFinite(tempoLoteW)
      ? (tempoLoteW * (unidadeTempoW === "dia" ? horasPorDia : 1)) / tamanhoLoteW
      : null;

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
    };

    // diretriz/lote so existem para SKU fabricado (coerencia de tipo_origem);
    // tempo_producao e derivado no backend a partir do lote.
    const input = fabricado
      ? {
          ...base,
          diretriz_producao: values.diretriz_producao?.trim()
            ? values.diretriz_producao.trim()
            : null,
          tamanho_lote: values.tamanho_lote ?? null,
          tempo_lote: values.tempo_lote ?? null,
          unidade_tempo: values.unidade_tempo,
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
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <label htmlFor="sku-tipo">Origem</label>
            <span className="helper" style={{ margin: 0 }}>
              {isEdit
                ? "A origem não muda após a criação."
                : fabricado
                  ? "Custo via composição (BOM) + mão de obra."
                  : "Custo via custo de aquisição vigente."}
            </span>
          </div>
          <select id="sku-tipo" disabled={isEdit} {...register("tipo_origem")}>
            <option value="fabricado">Fabricado (BOM)</option>
            <option value="comprado">Comprado (aquisição)</option>
          </select>
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
          <div
            className="grid-fields"
            style={{ gridTemplateColumns: "1fr 1fr 1fr", alignItems: "start" }}
          >
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="sku-tamanho-lote">Peças por lote</label>
              <input
                id="sku-tamanho-lote"
                type="number"
                step="any"
                placeholder="Opcional"
                {...register("tamanho_lote", { valueAsNumber: true })}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="sku-tempo-lote">Tempo para produzir o lote</label>
              <input
                id="sku-tempo-lote"
                type="number"
                step="any"
                placeholder="Opcional"
                {...register("tempo_lote", { valueAsNumber: true })}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="sku-unidade-tempo">Unidade do tempo</label>
              <select id="sku-unidade-tempo" {...register("unidade_tempo")}>
                <option value="hora">Horas</option>
                <option value="dia">Dias</option>
              </select>
            </div>
          </div>
          <div className="helper" style={{ marginTop: 8 }}>
            Tempo por unidade:{" "}
            <strong className="tnum">
              {tempoPorUnidade == null
                ? "—"
                : `${tempoPorUnidade.toFixed(4)} h (${Math.round(tempoPorUnidade * 3600)} s)`}
            </strong>
            {unidadeTempoW === "dia" && ` · ${horasPorDia} h/dia (jornada)`}
            {" · derivado do lote (o motor recalcula no salvar)."}
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
        {isEdit && onDelete && (
          confirmingDelete ? (
            <>
              <button
                type="button"
                className="btn"
                style={{ color: "var(--err)", marginLeft: "auto" }}
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
                className="btn"
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
              className="btn"
              style={{ color: "var(--err)", marginLeft: "auto" }}
              onClick={() => setConfirmingDelete(true)}
              disabled={pending}
            >
              <Trash2 aria-hidden="true" />
              <span>Excluir SKU</span>
            </button>
          )
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
