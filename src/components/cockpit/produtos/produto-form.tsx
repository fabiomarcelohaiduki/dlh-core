"use client";

import { useMemo, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Info, Loader2, TriangleAlert, X } from "lucide-react";
import { useCreateProduto, useUpdateProduto } from "@/hooks/use-produtos";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { AtributoSchema, Produto } from "@/lib/api/types";

/**
 * Constroi o sub-schema zod dos atributos flexiveis a partir do schema da
 * Linha: tipo texto/numero/booleano + obrigatorio. Numeros aceitam vazio
 * (tratado como ausente) e exigem valor quando obrigatorio.
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

type ProdutoFormValues = {
  nome: string;
  atributos: Record<string, string | number | boolean | undefined>;
  prazo_entrega?: string;
  disponibilidade?: string;
  pedido_minimo?: string;
};

/**
 * cmp-produto-form — dados do Produto: nome, ATRIBUTOS FLEXIVEIS renderizados
 * dinamicamente do schema da Linha (texto/numero/booleano, obrigatorios
 * marcados) e campos comerciais. Quando a Linha nao define atributos, mostra o
 * estado vazio orientando a defini-los na Linha. Validacao react-hook-form +
 * zod inline; nao cria registro parcial em erro.
 */
export function ProdutoForm({
  linhaId,
  schema,
  produto,
  onSuccess,
  onCancel,
}: {
  linhaId: string;
  schema: AtributoSchema[];
  produto?: Produto;
  onSuccess?: (produto: Produto) => void;
  onCancel?: () => void;
}) {
  const isEdit = Boolean(produto);
  const createProduto = useCreateProduto();
  const updateProduto = useUpdateProduto();
  const pending = createProduto.isPending || updateProduto.isPending;

  const [apiError, setApiError] = useState<string | null>(null);

  const formSchema = useMemo(
    () =>
      z.object({
        nome: z.string().trim().min(1, "Informe o nome do produto."),
        atributos: buildAtributosSchema(schema),
        prazo_entrega: z.string().trim().optional(),
        disponibilidade: z.string().trim().optional(),
        pedido_minimo: z.string().trim().optional(),
      }),
    [schema],
  );

  const defaultAtributos = useMemo(() => {
    const base: Record<string, string | number | boolean | undefined> = {};
    for (const a of schema) {
      const current = produto?.atributos?.[a.chave];
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
  }, [schema, produto]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ProdutoFormValues>({
    resolver: zodResolver(formSchema) as Resolver<ProdutoFormValues>,
    defaultValues: {
      nome: produto?.nome ?? "",
      atributos: defaultAtributos,
      prazo_entrega: produto?.prazo_entrega ?? "",
      disponibilidade: produto?.disponibilidade ?? "",
      pedido_minimo: produto?.pedido_minimo ?? "",
    },
  });

  const atributoErrors = errors.atributos as
    | Record<string, { message?: string } | undefined>
    | undefined;

  async function onSubmit(values: ProdutoFormValues) {
    setApiError(null);

    // Monta o JSONB de atributos somente com os valores informados, conforme o
    // schema da Linha (o backend rejeita chave fora do schema).
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

    const input = {
      linha_id: linhaId,
      nome: values.nome,
      atributos,
      prazo_entrega: values.prazo_entrega?.trim() ? values.prazo_entrega.trim() : null,
      disponibilidade: values.disponibilidade?.trim()
        ? values.disponibilidade.trim()
        : null,
      pedido_minimo: values.pedido_minimo?.trim() ? values.pedido_minimo.trim() : null,
    };

    try {
      const saved =
        isEdit && produto
          ? await updateProduto.mutateAsync({ id: produto.id, input })
          : await createProduto.mutateAsync(input);
      onSuccess?.(saved);
    } catch (err) {
      setApiError(
        err instanceof ApiError && err.status === 400
          ? "Dados inválidos: confira os atributos obrigatórios da linha."
          : "Não foi possível salvar o produto. Tente novamente.",
      );
    }
  }

  return (
    <form className="card form-card--wide" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="section-title" style={{ margin: "0 0 16px" }}>
        <h3>{isEdit ? "Dados do produto" : "Novo produto"}</h3>
      </div>

      <div className={cn("field", errors.nome && "invalid")} style={{ maxWidth: 420 }}>
        <label htmlFor="produto-nome">Nome</label>
        <input
          id="produto-nome"
          type="text"
          placeholder="ex.: Liquidificador 600W"
          aria-invalid={Boolean(errors.nome)}
          {...register("nome")}
        />
        <div className="err-msg">
          <TriangleAlert aria-hidden="true" />
          {errors.nome?.message ?? "Informe o nome do produto."}
        </div>
      </div>

      <div className="section-title" style={{ margin: "22px 0 13px" }}>
        <h3>Atributos da linha</h3>
      </div>
      {schema.length === 0 ? (
        <div className="empty">
          <Info aria-hidden="true" />
          <h4>Esta linha ainda não define atributos</h4>
          <p>
            Defina os atributos (chave, tipo, obrigatório) na Linha para que eles
            apareçam aqui e sejam preenchidos por Produto.
          </p>
        </div>
      ) : (
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
                  </div>
                </label>
              );
            }
            return (
              <div key={a.chave} className={cn("field", fieldError && "invalid")}>
                <label htmlFor={`attr-${a.chave}`}>
                  {a.chave}
                  {a.obrigatorio ? " *" : ""}
                </label>
                <input
                  id={`attr-${a.chave}`}
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
      )}

      <div className="section-title" style={{ margin: "22px 0 13px" }}>
        <h3>Condições comerciais</h3>
      </div>
      <div className="grid-fields">
        <div className="field">
          <label htmlFor="produto-prazo">Prazo de entrega</label>
          <input
            id="produto-prazo"
            type="text"
            placeholder="ex.: 10 dias úteis"
            {...register("prazo_entrega")}
          />
        </div>
        <div className="field">
          <label htmlFor="produto-disp">Disponibilidade</label>
          <input
            id="produto-disp"
            type="text"
            placeholder="ex.: Pronta entrega"
            {...register("disponibilidade")}
          />
        </div>
        <div className="field">
          <label htmlFor="produto-pedmin">Pedido mínimo</label>
          <input
            id="produto-pedmin"
            type="text"
            placeholder="ex.: 50 unidades"
            {...register("pedido_minimo")}
          />
        </div>
      </div>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{pending ? "Salvando…" : isEdit ? "Salvar produto" : "Criar produto"}</span>
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
