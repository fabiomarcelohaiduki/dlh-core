"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { useCreateLinha, useUpdateLinha } from "@/hooks/use-linhas";
import { useProdutos } from "@/hooks/use-produtos";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { FotoThumb } from "@/components/cockpit/produtos/foto-thumb";
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

  // Foto de capa: produto da Linha cuja 1a foto representa a Linha. null =
  // automatico (1o produto por nome com foto). So no modo edicao (precisa da
  // Linha existente para listar seus produtos).
  const [capaId, setCapaId] = useState<string | null>(linha?.produto_capa_id ?? null);
  const produtos = useProdutos(linha ? { linha_id: linha.id } : {});
  const produtosComFoto = (produtos.data?.items ?? []).filter((p) => p.foto_url);
  const capaChanged = isEdit && capaId !== (linha?.produto_capa_id ?? null);

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
      ...(isEdit ? { produto_capa_id: capaId } : {}),
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

      {isEdit && (
        <div className="field" style={{ marginTop: 18 }}>
          <label>Foto de capa</label>
          <div className="helper" style={{ marginBottom: 10 }}>
            Escolhe qual produto representa a linha na listagem. Automático usa o
            primeiro produto por nome.
          </div>
          {produtosComFoto.length === 0 ? (
            <div className="helper">
              Nenhum produto desta linha tem foto ainda.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
                gap: 10,
              }}
            >
              <button
                type="button"
                onClick={() => setCapaId(null)}
                aria-pressed={capaId === null}
                className={cn("card", capaId === null && "active-row")}
                style={{
                  margin: 0,
                  padding: 8,
                  display: "grid",
                  gap: 6,
                  justifyItems: "center",
                  cursor: "pointer",
                  borderColor: capaId === null ? "var(--accent)" : undefined,
                }}
                title="Automático (1º produto por nome)"
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 8,
                    display: "grid",
                    placeItems: "center",
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <Sparkles size={18} style={{ color: "var(--muted)" }} aria-hidden="true" />
                </div>
                <span className="sub" style={{ textAlign: "center" }}>
                  Automático
                </span>
              </button>
              {produtosComFoto.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setCapaId(p.id)}
                  aria-pressed={capaId === p.id}
                  className={cn("card", capaId === p.id && "active-row")}
                  style={{
                    margin: 0,
                    padding: 8,
                    display: "grid",
                    gap: 6,
                    justifyItems: "center",
                    cursor: "pointer",
                    borderColor: capaId === p.id ? "var(--accent)" : undefined,
                  }}
                  title={p.nome}
                >
                  <FotoThumb url={p.foto_url} alt={p.nome} size={44} />
                  <span
                    className="sub"
                    style={{
                      textAlign: "center",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "100%",
                    }}
                  >
                    {p.nome}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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
        {isEdit && !isDirty && !capaChanged && !apiError ? (
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
