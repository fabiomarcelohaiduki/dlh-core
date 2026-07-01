"use client";

// =====================================================================
// AprovacaoModal - modal de revisao antes do INSERT para a sub-secao D
// (Aprovacoes pendentes) do painel de Relacionamentos.
//
// Suporta 3 modos de decisao espelhados em
// `POST /relacionamentos-vinculos-lia/decidir`:
//
//   - aprovar : preview da regra resultante (origem_tipo, destino_tipo,
//               combinacao, sequencia); sem motivo obrigatorio.
//   - rejeitar: input motivo obrigatorio. Nao altera a regra.
//   - editar  : campos editaveis (descricao/sequencia) + motivo obrigatorio.
//
// Validacao client-side:
//   - Hard block anti `numero_pregao` (RNF-14 / US-12 CA-03): se
//     combinacao='simples' AND campo_destino='numero_pregao', o modal
//     mostra erro e o botao Confirmar fica desabilitado.
//   - Refine zod que espelha vinculoLiaDecidirSchema (motivo obrigatorio
//     quando acao != 'aprovar').
//
// A submissao chama `useDecidirVinculoLia()` que invalida as chaves de
// cache relevantes (lista de vinculos + possivel cascata para o catalogo
// de regras humanas). Apos o sucesso o modal fecha sozinho (parent
// controla `open`) e exibe toast verde.
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Loader2,
  Lightbulb,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Pill } from "@/components/ui/pill";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api/client";
import {
  REL_NUMERO_PREGAO_MSG,
  RELACIONAMENTOS_TIPOS_NO,
} from "@/lib/api/relacionamentos-zod";
import type {
  RelacionamentoCombinacao,
  RelacionamentoTipoNo,
  RelacionamentoVinculoDecisao,
  VinculoLia,
  VinculoLiaDecidirDados,
  VinculoLiaDecidirInput,
} from "@/lib/api/relacionamentos-types";
import { useDecidirVinculoLia } from "@/hooks/relacionamentos/use-relacionamentos-vinculos-lia";
import { CAMPOS_POR_TIPO } from "./regras-form-helpers";

// ---------------------------------------------------------------------
// Tipos locais.
// ---------------------------------------------------------------------

/** Modo inicial do modal (controlado pela view que abre o modal). */
export type AprovacaoModo = "aprovar" | "rejeitar" | "editar";

/** Valores tipados do formulario local. Espelham os dados do decidir + descricao. */
export interface AprovacaoFormValues {
  origem_tipo: RelacionamentoTipoNo;
  destino_tipo: RelacionamentoTipoNo;
  combinacao: RelacionamentoCombinacao;
  sequencia: string[];
  descricao: string;
  motivo: string;
}

// ---------------------------------------------------------------------
// Labels PT-BR (espelham o RegraForm para manter coerencia visual).
// ---------------------------------------------------------------------

const TIPO_NO_LABEL: Record<RelacionamentoTipoNo, string> = {
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

const COMBINACAO_LABEL: Record<RelacionamentoCombinacao, string> = {
  simples: "Simples",
  composta: "Composta",
};

const MODO_TITULO: Record<AprovacaoModo, string> = {
  aprovar: "Aprovar vínculo como regra humana",
  rejeitar: "Rejeitar vínculo inferido pela Lia",
  editar: "Editar vínculo inferido pela Lia",
};

const MODO_DESCRICAO: Record<AprovacaoModo, string> = {
  aprovar:
    "Revise a regra resultante antes de promover. O vínculo entra como ativa e a regra humana é inserida no catálogo.",
  rejeitar:
    "O vínculo será marcado como rejeitado. Informe o motivo - o registro entra no audit log.",
  editar:
    "Ajuste os campos do vínculo antes da decisão. Informe o motivo - o registro entra no audit log.",
};

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

/**
 * Defaults estaveis para o formulario. A descricao da Lia e livre, entao
 * usamos a heuristica de origem/destino mais comum (aviso -> produto por
 * numero_pregao) que o usuario pode editar.
 */
function defaultsPara(vinculo: VinculoLia | null): AprovacaoFormValues {
  const descricao = vinculo?.descricao ?? "";
  return {
    origem_tipo: "aviso",
    destino_tipo: "produto",
    combinacao: "composta",
    sequencia: ["numero_pregao", "uasg"],
    descricao,
    motivo: "",
  };
}

/** Mapeia erro do backend em PT-BR. */
function mapApiErrorToPtBr(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400) return "Dados inválidos: revise os campos.";
    if (err.status === 404) return "Este vínculo não existe mais.";
    if (err.status === 409)
      return "Conflito: o vínculo mudou de estado durante a operação.";
    if (err.status === 422)
      return "Operação inválida: confira a combinação e o campo de destino.";
    return err.message || "Não foi possível processar a decisão. Tente novamente.";
  }
  return "Não foi possível processar a decisão. Tente novamente.";
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export interface AprovacaoModalProps {
  open: boolean;
  onClose: () => void;
  vinculo: VinculoLia | null;
  /** Modo inicial; o modal ajusta labels, descricao e required-ness. */
  acaoInicial: AprovacaoModo;
}

/**
 * AprovacaoModal - modal de revisao para o fluxo de decisao da Lia.
 *
 * Mantem um RHF local com os campos necessarios (dados da regra +
 * descricao + motivo). O submit traduz para `VinculoLiaDecidirInput`
 * (espelho do backend) e dispara `useDecidirVinculoLia`. Modal fecha
 * sozinho apos o sucesso (parent controla `open`).
 */
export function AprovacaoModal({
  open,
  onClose,
  vinculo,
  acaoInicial,
}: AprovacaoModalProps) {
  const decidir = useDecidirVinculoLia();
  const { toast } = useToast();

  const [apiError, setApiError] = useState<string | null>(null);
  /** Estado local do campo_destino preview (controla o hard-block visual). */
  const [campoDestinoEscolhido, setCampoDestinoEscolhido] = useState<string>(
    "sku",
  );

  const defaults = useMemo(() => defaultsPara(vinculo), [vinculo]);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    reset,
  } = useForm<AprovacaoFormValues>({
    defaultValues: defaults,
    mode: "onChange",
  });

  // Resetar defaults sempre que o vinculo alvo muda ou o modal reabre.
  useEffect(() => {
    if (open) {
      reset(defaults);
      setApiError(null);
      setCampoDestinoEscolhido("sku");
    }
  }, [open, defaults, reset]);

  const acao: RelacionamentoVinculoDecisao = acaoInicial;
  const motivoObrigatorio = acao !== "aprovar";

  const origemTipo = watch("origem_tipo");
  const destinoTipo = watch("destino_tipo");
  const combinacao = watch("combinacao");
  const motivo = watch("motivo");

  const camposOrigem = useMemo(
    () => CAMPOS_POR_TIPO[origemTipo] ?? [],
    [origemTipo],
  );
  const camposDestino = useMemo(
    () => CAMPOS_POR_TIPO[destinoTipo] ?? [],
    [destinoTipo],
  );

  /**
   * Hard block: regra simples onde o unico campo destino e numero_pregao
   * tem alta taxa de falso positivo. A UI deve impedir o envio; o backend
   * repete o gate via trigger SQL + zod. Espelha RegraForm.
   */
  const isHardBlocked =
    combinacao === "simples" && campoDestinoEscolhido === "numero_pregao";

  /** Motivo requerido (zod refine + visual). */
  const motivoVazio = !motivo || motivo.trim() === "";
  const motivoInvalido = motivoObrigatorio && motivoVazio;

  const pending = decidir.isPending;

  function applySugestaoComposta() {
    setValue("combinacao", "composta", {
      shouldDirty: true,
      shouldValidate: true,
    });
    setValue("sequencia", ["numero_pregao", "uasg"], {
      shouldDirty: true,
      shouldValidate: true,
    });
    setCampoDestinoEscolhido("numero_pregao");
  }

  async function onSubmit(values: AprovacaoFormValues) {
    if (!vinculo) return;
    if (isHardBlocked) {
      setApiError(REL_NUMERO_PREGAO_MSG);
      return;
    }
    if (motivoObrigatorio && motivoVazio) {
      setApiError("Informe o motivo para rejeitar ou editar o vínculo.");
      return;
    }
    setApiError(null);
    try {
      const dados: VinculoLiaDecidirDados = {
        origem_tipo: values.origem_tipo,
        destino_tipo: values.destino_tipo,
        combinacao: values.combinacao,
      };
      if (values.combinacao === "composta" && values.sequencia.length > 0) {
        dados.sequencia = values.sequencia.map((s) => s.trim()).filter(Boolean);
      }
      const payload: VinculoLiaDecidirInput = {
        vinculo_id: vinculo.id,
        acao,
        dados,
      };
      if (motivoObrigatorio && !motivoVazio) {
        payload.motivo = values.motivo.trim();
      }
      // Para a acao 'editar' propagamos tambem a descricao revisada para
      // o PUT subsequente, espelhando o backend.
      if (acao === "editar" && values.descricao.trim()) {
        payload.descricao = values.descricao.trim();
      }
      await decidir.mutateAsync(payload);
      const tituloPorAcao: Record<RelacionamentoVinculoDecisao, string> = {
        aprovar: "Regra aprovada",
        rejeitar: "Vínculo rejeitado",
        editar: "Vínculo atualizado",
      };
      toast({ title: tituloPorAcao[acao], variant: "ok" });
      onClose();
    } catch (err) {
      const msg = mapApiErrorToPtBr(err);
      setApiError(msg);
      toast({
        title: "Erro ao processar decisão",
        description: msg,
        variant: "danger",
      });
    }
  }

  // Reset do erro do backend ao trocar valores-chave.
  useEffect(() => {
    setApiError(null);
  }, [origemTipo, destinoTipo, combinacao]);

  const botaoLabel = useMemo(() => {
    if (pending) {
      return acao === "aprovar"
        ? "Aprovando…"
        : acao === "rejeitar"
          ? "Rejeitando…"
          : "Salvando…";
    }
    if (acao === "aprovar") return "Confirmar aprovação";
    if (acao === "rejeitar") return "Confirmar rejeição";
    return "Salvar alterações";
  }, [acao, pending]);

  return (
    <Modal
      open={open && Boolean(vinculo)}
      onClose={onClose}
      title={MODO_TITULO[acao]}
      description={MODO_DESCRICAO[acao]}
      width={640}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={pending}
            data-btn="cancelar-aprovacao"
          >
            <X aria-hidden="true" />
            <span>Cancelar</span>
          </Button>
          <Button
            type="submit"
            form="aprovacao-form"
            variant="primary"
            disabled={pending || isHardBlocked || motivoInvalido}
            aria-disabled={pending || isHardBlocked || motivoInvalido}
            data-btn="confirmar-aprovacao"
            title={
              isHardBlocked
                ? REL_NUMERO_PREGAO_MSG
                : motivoInvalido
                  ? "Informe o motivo para esta ação"
                  : undefined
            }
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : acao === "aprovar" ? (
              <Sparkles aria-hidden="true" />
            ) : acao === "rejeitar" ? (
              <Trash2 aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            <span>{botaoLabel}</span>
            {isHardBlocked ? (
              <Pill variant="warn" className="ml-1" dot>
                bloqueada
              </Pill>
            ) : null}
          </Button>
        </>
      }
    >
      <form
        id="aprovacao-form"
        data-form="aprovacao"
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="flex flex-col gap-4"
      >
        {/* Resumo do vinculo alvo ---------------------------------------- */}
        {vinculo ? (
          <section
            data-card="vinculo-resumo"
            className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-2/40 p-3"
          >
            <p className="text-[12.5px] text-muted">
              <strong className="text-fg">Vínculo alvo.</strong>{" "}
              {vinculo.descricao}
            </p>
            <p className="font-mono text-[11.5px] text-faint">
              id: {vinculo.id} · uso: {vinculo.contador_uso ?? 0} · 2
              caminhos: {vinculo.contador_2caminhos ?? 0}
            </p>
          </section>
        ) : null}

        {/* Preview da regra resultante ----------------------------------- */}
        <section className="flex flex-col gap-2">
          <header className="flex items-center justify-between gap-2">
            <h3 className="text-[13.5px] font-semibold text-fg">
              Preview da regra
            </h3>
            <Pill variant={acao === "aprovar" ? "ok" : "warn"} dot>
              {COMBINACAO_LABEL[combinacao]}
            </Pill>
          </header>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="aprovacao-origem-tipo"
                className="text-[12.5px] font-medium text-muted"
              >
                Nó de origem
              </label>
              <Controller
                control={control}
                name="origem_tipo"
                render={({ field }) => (
                  <Select
                    id="aprovacao-origem-tipo"
                    value={field.value}
                    onChange={(e) =>
                      field.onChange(e.target.value as RelacionamentoTipoNo)
                    }
                  >
                    {RELACIONAMENTOS_TIPOS_NO.map((t) => (
                      <option key={t} value={t}>
                        {TIPO_NO_LABEL[t]}
                      </option>
                    ))}
                  </Select>
                )}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="aprovacao-destino-tipo"
                className="text-[12.5px] font-medium text-muted"
              >
                Nó de destino
              </label>
              <Controller
                control={control}
                name="destino_tipo"
                render={({ field }) => (
                  <Select
                    id="aprovacao-destino-tipo"
                    value={field.value}
                    onChange={(e) =>
                      field.onChange(e.target.value as RelacionamentoTipoNo)
                    }
                  >
                    {RELACIONAMENTOS_TIPOS_NO.map((t) => (
                      <option key={t} value={t}>
                        {TIPO_NO_LABEL[t]}
                      </option>
                    ))}
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="aprovacao-campo-origem"
                className="text-[12.5px] font-medium text-muted"
              >
                Campo de origem (preview)
              </label>
              <Select
                id="aprovacao-campo-origem"
                defaultValue={camposOrigem[0]?.value ?? ""}
                disabled={camposOrigem.length === 0}
                data-select="campo-origem"
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
              <p className="text-[11.5px] text-faint">
                Sugerido pelo destino. Editável na regra humana completa.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="aprovacao-campo-destino"
                className="text-[12.5px] font-medium text-muted"
              >
                Campo de destino (preview)
              </label>
              <Select
                id="aprovacao-campo-destino"
                defaultValue={camposDestino[0]?.value ?? ""}
                onChange={(e) => setCampoDestinoEscolhido(e.target.value)}
                disabled={camposDestino.length === 0}
                data-select="campo-destino"
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
              {isHardBlocked ? (
                <p
                  className="flex items-center gap-1 text-[11.5px] text-err"
                  data-msg="hard-block-numero-pregao"
                >
                  <TriangleAlert className="size-3" aria-hidden="true" />
                  {REL_NUMERO_PREGAO_MSG}
                </p>
              ) : null}
            </div>
          </div>

          {/* Combinacao + sequencia ------------------------------------- */}
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-medium text-muted">
              Combinação
            </span>
            <div
              role="radiogroup"
              aria-label="Tipo de combinação da regra resultante"
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
                  <strong>Composta</strong> - vários campos (AND).
                </span>
              </label>
            </div>

            {combinacao === "composta" ? (
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="aprovacao-sequencia"
                  className="text-[12.5px] font-medium text-muted"
                >
                  Sequência de campos
                </label>
                <Controller
                  control={control}
                  name="sequencia"
                  render={({ field }) => (
                    <Input
                      id="aprovacao-sequencia"
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
                  Separe por vírgula. Espelha o motor de match do backfill.
                </p>
              </div>
            ) : null}
          </div>

          {/* Sugestao de regra composta (so com hard-block ativo) ------ */}
          {isHardBlocked ? (
            <button
              type="button"
              onClick={applySugestaoComposta}
              data-btn="sugerir-composta-aprovacao"
              className={cn(
                "flex items-start gap-2 rounded-md border border-warn/40 bg-warn-bg/40",
                "px-3 py-2.5 text-left transition-colors",
                "hover:bg-warn-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
              )}
            >
              <Lightbulb
                className="mt-0.5 size-4 flex-none text-warn"
                aria-hidden="true"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[12.5px] font-semibold text-fg">
                  Sugerir regra composta (numero_pregao + uasg)
                </span>
                <span className="text-[11.5px] text-muted">
                  Clique para preencher a sequência com 2 chaves estáveis -
                  reduz drasticamente a taxa de falso positivo.
                </span>
              </span>
            </button>
          ) : null}
        </section>

        {/* Descricao revisada (modo editar apenas) --------------------- */}
        {acao === "editar" ? (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="aprovacao-descricao"
              className="text-[12.5px] font-medium text-muted"
            >
              Descrição revisada
            </label>
            <textarea
              id="aprovacao-descricao"
              data-input="descricao"
              rows={3}
              {...register("descricao")}
              className={cn(
                "w-full resize-y rounded-sm border border-border bg-surface-2 px-3 py-2 text-[13.5px] text-fg",
                "placeholder:text-muted focus-visible:border-accent-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
              )}
              placeholder="Reescreva a descrição do vínculo se necessário."
            />
          </div>
        ) : null}

        {/* Motivo (rejeitar / editar) ---------------------------------- */}
        {motivoObrigatorio ? (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="aprovacao-motivo"
              className="text-[12.5px] font-medium text-muted"
            >
              Motivo <span className="text-err" aria-hidden="true">*</span>
              <span className="sr-only"> (obrigatório)</span>
            </label>
            <textarea
              id="aprovacao-motivo"
              data-input="motivo"
              rows={3}
              {...register("motivo")}
              aria-required="true"
              aria-invalid={motivoInvalido ? true : undefined}
              className={cn(
                "w-full resize-y rounded-sm border bg-surface-2 px-3 py-2 text-[13.5px] text-fg",
                "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2",
                motivoInvalido
                  ? "border-err focus-visible:border-err focus-visible:ring-err-bg"
                  : "border-border focus-visible:border-accent-line focus-visible:ring-accent-line",
              )}
              placeholder={
                acao === "rejeitar"
                  ? "Por que este vínculo deve ser rejeitado?"
                  : "Por que o vínculo está sendo editado?"
              }
            />
            {motivoInvalido ? (
              <p className="flex items-center gap-1 text-[11.5px] text-err">
                <TriangleAlert className="size-3" aria-hidden="true" />
                Motivo é obrigatório para esta ação.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Erro agregado do backend ----------------------------------- */}
        {apiError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-err/40 bg-err-bg/40 px-3 py-2.5 text-[12.5px] text-err"
          >
            <TriangleAlert className="mt-0.5 size-4 flex-none" aria-hidden="true" />
            <span>{apiError}</span>
          </div>
        ) : null}

        {/* Aviso de audit log ----------------------------------------- */}
        <p className="text-[11.5px] text-faint">
          Esta ação gera um registro no audit log da org (quem decidiu,
          quando e por quê).
        </p>
      </form>
    </Modal>
  );
}
