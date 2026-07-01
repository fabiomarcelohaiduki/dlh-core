"use client";

// =====================================================================
// RegraForm - formulario de criacao/edicao de regra humana do catalogo
// de vinculos (`catalogo_regras_vinculo`).
//
// Usa react-hook-form + zodResolver com regraCreateSchema (ou
// regraUpdateSchema no modo edicao) e implementa:
//   1) Campos: origem_tipo, campo_origem, destino_tipo, campo_destino,
//      combinacao (radio), sequencia (visivel so se composta), ativa,
//      nome opcional;
//   2) Hard block anti `numero_pregao` (simples + campo_destino=) conforme
//      RNF-14 e US-12 CA-03 - botao Salvar desabilitado com tooltip
//      explicando que essa combinacao gera falsos positivos;
//   3) Chip de sugestao "Sugerir regra composta (numero_pregao + uasg)"
//      que preenche sequencia=['numero_pregao','uasg'] e combinacao=composta;
//   4) Sem botao "salvar mesmo assim" - o gate e definitivo (RNF-14);
//   5) Toasts verde "Regra salva" / vermelho em PT-BR para 422/409/etc.
//
// Erros do endpoint sao retornados via `onError` ou callback local; o
// formulario aceita `onSuccess` opcional para fechar o modal apos salvar.
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Lightbulb, Loader2, TriangleAlert, X } from "lucide-react";
import {
  REL_NUMERO_PREGAO_MSG,
  RELACIONAMENTOS_TIPOS_NO,
  regraCreateSchema,
  regraUpdateSchema,
} from "@/lib/api/relacionamentos-zod";
import {
  CAMPOS_POR_TIPO,
  type RegraFormValues,
  type RelacaoTipoNoCampo,
  regraCreateDefaults,
  regraUpdateDefaults,
  toRegraCreateInput,
  toRegraUpdateInput,
} from "./regras-form-helpers";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api/client";
import { useCriarRelacionamentosRegra, useEditarRelacionamentosRegra } from "@/hooks/relacionamentos/use-relacionamentos-regras";
import type { Regra, RegraCreateInput } from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers visuais (rotulos em PT-BR para tipos de no).
// ---------------------------------------------------------------------

const TIPO_NO_LABEL: Record<RelacaoTipoNoCampo["tipo"], string> = {
  aviso: "Aviso",
  processo: "Processo",
  documento: "Documento",
  pessoa: "Pessoa",
  produto: "Produto",
  linha: "Linha",
  sku: "SKU",
  preco: "Preço",
  politica: "Política",
  cotacao_diretriz: "Diretriz",
};

/** Indica se o formulario esta no modo edicao. */
export function RegraForm({
  regra,
  onSuccess,
  onCancel,
}: {
  regra?: Regra;
  onSuccess?: (regra: Regra) => void;
  onCancel?: () => void;
}) {
  const isEdit = Boolean(regra);
  const schema = isEdit ? regraUpdateSchema : regraCreateSchema;

  const createRegra = useCriarRelacionamentosRegra();
  const editRegra = useEditarRelacionamentosRegra();
  const { toast } = useToast();

  const pending = createRegra.isPending || editRegra.isPending;

  // Estado local de erro do backend (PT-BR), separado dos erros do zod.
  const [apiError, setApiError] = useState<string | null>(null);

  const defaults: RegraFormValues = useMemo(
    () => (isEdit && regra ? regraUpdateDefaults(regra) : regraCreateDefaults()),
    [isEdit, regra],
  );

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<RegraFormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
    mode: "onChange",
  });

  const origemTipo = watch("origem_tipo");
  const destinoTipo = watch("destino_tipo");
  const campoDestino = watch("campo_destino");
  const combinacao = watch("combinacao");

  /**
   * Allowlist de campos por tipo de no. Hardcoded intencionalmente: a
   * sugestao de chave vem do dominio (aviso.pregao, processo.numero etc)
   * e precisa ser estavel para que a correspondencia no backfill seja
   * deterministica.
   */
  const camposOrigem = useMemo(
    () => CAMPOS_POR_TIPO[origemTipo] ?? [],
    [origemTipo],
  );
  const camposDestino = useMemo(
    () => CAMPOS_POR_TIPO[destinoTipo] ?? [],
    [destinoTipo],
  );

  /**
   * Hard block: regra simples onde o unico campo destino e `numero_pregao`
   * tem alta taxa de falso positivo. A UI deve impedir o envio; o backend
   * e o trigger SQL repetem o gate. Sem bypass.
   */
  const isHardBlocked =
    combinacao === "simples" && campoDestino === "numero_pregao";

  /** Handlers ------------------------------------------------------------ */

  function applySugestaoComposta() {
    setValue("combinacao", "composta", { shouldDirty: true, shouldValidate: true });
    setValue("sequencia", ["numero_pregao", "uasg"], { shouldDirty: true, shouldValidate: true });
    setValue("campo_destino", "numero_pregao", { shouldDirty: true, shouldValidate: true });
    setValue("campo_origem", "numero_pregao", { shouldDirty: true, shouldValidate: true });
  }

  function formatZodError(message: string | undefined, fallback: string): string {
    return message ?? fallback;
  }

  /** Submissao: traduce os valores tipados para o input do backend. */
  async function onSubmit(values: RegraFormValues) {
    if (isHardBlocked) {
      // Defesa em profundidade: zod deveria ter bloqueado, mas se a UI
      // chegar aqui por manipulação, garantimos o gate.
      setApiError(REL_NUMERO_PREGAO_MSG);
      return;
    }
    setApiError(null);
    try {
      let saved: Regra;
      if (isEdit && regra) {
        const input = toRegraUpdateInput(values);
        saved = await editRegra.mutateAsync({ id: regra.id, input });
        toast({ title: "Regra salva", variant: "ok" });
      } else {
        const input: RegraCreateInput = toRegraCreateInput(values);
        saved = await createRegra.mutateAsync(input);
        toast({ title: "Regra salva", variant: "ok" });
      }
      onSuccess?.(saved);
    } catch (err) {
      const msg = mapApiErrorToPtBr(err);
      setApiError(msg);
      toast({ title: "Erro ao salvar regra", description: msg, variant: "danger" });
    }
  }

  // Reset do erro do backend ao trocar valores.
  useEffect(() => {
    setApiError(null);
  }, [origemTipo, destinoTipo, combinacao]);

  /** Render -------------------------------------------------------------- */

  return (
    <form
      data-form="regra"
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold text-fg">
          {isEdit ? "Editar regra" : "Nova regra humana"}
        </h3>
        <p className="text-[12.5px] text-muted">
          Define um match deterministico entre campos de 2 nos para criar arestas
          no grafo. Regras compostas combinam varios campos (AND logico) e sao
          mais precisas.
        </p>
      </header>

      {/* Nome opcional ----------------------------------------------------- */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="regra-nome"
          className="text-[12.5px] font-medium text-muted"
        >
          Nome (opcional)
        </label>
        <Input
          id="regra-nome"
          type="text"
          placeholder="ex.: Match aviso → produto por UASG + numero do pregao"
          {...register("nome")}
        />
        <p className="text-[11.5px] text-faint">
          Rótulo humano para localizar a regra no catalogo. Sem efeito no match.
        </p>
      </div>

      {/* Origem / Campo origem -------------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="regra-origem-tipo"
            className="text-[12.5px] font-medium text-muted"
          >
            No de origem
          </label>
          <Controller
            control={control}
            name="origem_tipo"
            render={({ field }) => (
              <Select
                id="regra-origem-tipo"
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
              >
                {RELACIONAMENTOS_TIPOS_NO.map((t) => (
                  <option key={t} value={t}>
                    {TIPO_NO_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          />
          {errors.origem_tipo ? (
            <p className="flex items-center gap-1 text-[11.5px] text-err">
              <TriangleAlert className="size-3" aria-hidden="true" />
              {formatZodError(errors.origem_tipo.message, "Tipo de origem inválido.")}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="regra-campo-origem"
            className="text-[12.5px] font-medium text-muted"
          >
            Campo de origem
          </label>
          <Controller
            control={control}
            name="campo_origem"
            render={({ field }) => (
              <Select
                id="regra-campo-origem"
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
                disabled={camposOrigem.length === 0}
              >
                {camposOrigem.length === 0 ? (
                  <option value="">-</option>
                ) : (
                  camposOrigem.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))
                )}
              </Select>
            )}
          />
          {errors.campo_origem ? (
            <p className="flex items-center gap-1 text-[11.5px] text-err">
              <TriangleAlert className="size-3" aria-hidden="true" />
              {formatZodError(errors.campo_origem.message, "Campo de origem obrigatório.")}
            </p>
          ) : null}
        </div>
      </div>

      {/* Destino / Campo destino ------------------------------------------ */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="regra-destino-tipo"
            className="text-[12.5px] font-medium text-muted"
          >
            No de destino
          </label>
          <Controller
            control={control}
            name="destino_tipo"
            render={({ field }) => (
              <Select
                id="regra-destino-tipo"
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
              >
                {RELACIONAMENTOS_TIPOS_NO.map((t) => (
                  <option key={t} value={t}>
                    {TIPO_NO_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          />
          {errors.destino_tipo ? (
            <p className="flex items-center gap-1 text-[11.5px] text-err">
              <TriangleAlert className="size-3" aria-hidden="true" />
              {formatZodError(errors.destino_tipo.message, "Tipo de destino inválido.")}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="regra-campo-destino"
            className="text-[12.5px] font-medium text-muted"
          >
            Campo de destino
          </label>
          <Controller
            control={control}
            name="campo_destino"
            render={({ field }) => (
              <Select
                id="regra-campo-destino"
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
                disabled={camposDestino.length === 0}
              >
                {camposDestino.length === 0 ? (
                  <option value="">-</option>
                ) : (
                  camposDestino.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))
                )}
              </Select>
            )}
          />
          {errors.campo_destino ? (
            <p className="flex items-center gap-1 text-[11.5px] text-err">
              <TriangleAlert className="size-3" aria-hidden="true" />
              {formatZodError(errors.campo_destino.message, "Campo de destino obrigatório.")}
            </p>
          ) : (
            isHardBlocked ? (
              <p
                className="flex items-center gap-1 text-[11.5px] text-err"
                data-msg="hard-block-numero-pregao"
              >
                <TriangleAlert className="size-3" aria-hidden="true" />
                {REL_NUMERO_PREGAO_MSG}
              </p>
            ) : null
          )}
        </div>
      </div>

      {/* Combinacao + Sequencia ------------------------------------------- */}
      <div className="flex flex-col gap-2">
        <span className="text-[12.5px] font-medium text-muted">Combinação</span>
        <div
          role="radiogroup"
          aria-label="Tipo de combinação da regra"
          className="flex flex-col gap-2 sm:flex-row sm:gap-5"
        >
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input
              type="radio"
              value="simples"
              {...register("combinacao")}
              className="size-3.5 accent-[color:var(--accent)]"
            />
            <span>
              <strong>Simples</strong> - apenas 1 campo de destino.
            </span>
          </label>
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input
              type="radio"
              value="composta"
              {...register("combinacao")}
              className="size-3.5 accent-[color:var(--accent)]"
            />
            <span>
              <strong>Composta</strong> - vários campos (AND). Reduz falsos positivos.
            </span>
          </label>
        </div>

        {/* Sequencia (apenas composta) ---------------------------------- */}
        {combinacao === "composta" ? (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="regra-sequencia"
              className="text-[12.5px] font-medium text-muted"
            >
              Sequência de campos (na ordem em que serao combinados)
            </label>
            <Controller
              control={control}
              name="sequencia"
              render={({ field }) => (
                <Input
                  id="regra-sequencia"
                  type="text"
                  placeholder="ex.: numero_pregao, uasg"
                  value={Array.isArray(field.value) ? field.value.join(", ") : ""}
                  onChange={(e) => {
                    const arr = e.target.value
                      .split(/[\s,]+/)
                      .map((s) => s.trim())
                      .filter(Boolean);
                    field.onChange(arr);
                  }}
                />
              )}
            />
            <p className="text-[11.5px] text-faint">
              Separe por vírgula. Usado como pista pelo motor de match.
            </p>
            {errors.sequencia ? (
              <p className="flex items-center gap-1 text-[11.5px] text-err">
                <TriangleAlert className="size-3" aria-hidden="true" />
                {formatZodError(errors.sequencia.message as string | undefined, "Sequência inválida.")}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Sugestao de regra composta (visivel so com hard-block ativo) --- */}
      {isHardBlocked ? (
        <button
          type="button"
          onClick={applySugestaoComposta}
          data-btn="sugerir-composta"
          className={cn(
            "flex items-start gap-2 rounded-md border border-warn/40 bg-warn-bg/40",
            "px-3 py-2.5 text-left transition-colors",
            "hover:bg-warn-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
          )}
        >
          <Lightbulb className="mt-0.5 size-4 flex-none text-warn" aria-hidden="true" />
          <span className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-semibold text-fg">
              Sugerir regra composta (numero_pregao + uasg)
            </span>
            <span className="text-[11.5px] text-muted">
              Clique para preencher a sequência com 2 chaves estaveis - reduz
              drasticamente a taxa de falso positivo.
            </span>
          </span>
        </button>
      ) : null}

      {/* Ativa ------------------------------------------------------------- */}
      <label className="flex items-center gap-2 text-[13px] text-fg">
        <input
          type="checkbox"
          {...register("ativa")}
          className="size-3.5 accent-[color:var(--accent)]"
        />
        <span>
          Regra ativa - entra nas proximas rodadas de backfill.
        </span>
      </label>

      {/* Erro agregado do backend ----------------------------------------- */}
      {apiError ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-err/40 bg-err-bg/40 px-3 py-2.5 text-[12.5px] text-err"
        >
          <TriangleAlert className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <span>{apiError}</span>
        </div>
      ) : null}

      {/* Footer ------------------------------------------------------------ */}
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            <X aria-hidden="true" />
            <span>Cancelar</span>
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          disabled={pending || isHardBlocked}
          data-btn="salvar-regra"
          title={isHardBlocked ? REL_NUMERO_PREGAO_MSG : undefined}
          aria-disabled={pending || isHardBlocked}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{pending ? "Salvando…" : isEdit ? "Salvar alterações" : "Criar regra"}</span>
          {isHardBlocked ? (
            <Pill variant="warn" className="ml-1" dot>
              bloqueada
            </Pill>
          ) : null}
        </Button>
      </footer>

      {isEdit && !isDirty && !apiError ? (
        <p className="text-right text-[11.5px] text-faint">
          Sem alterações pendentes.
        </p>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------
// Mapeamento do erro do backend em PT-BR.
// ---------------------------------------------------------------------

function mapApiErrorToPtBr(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400) return "Dados inválidos: revise os campos.";
    if (err.status === 409)
      return "Já existe uma regra conflitante ou há vínculos pendentes que impedem a alteração.";
    if (err.status === 422)
      return "Regra inválida: confira a combinação e o campo de destino.";
    if (err.status === 404) return "Esta regra não existe mais.";
    return err.message || "Não foi possível salvar a regra. Tente novamente.";
  }
  return "Não foi possível salvar a regra. Tente novamente.";
}
