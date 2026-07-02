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
import {
  Check,
  FlaskConical,
  Lightbulb,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  REL_NUMERO_PREGAO_MSG,
  regraCreateSchema,
  regraUpdateSchema,
} from "@/lib/api/relacionamentos-zod";
import {
  type RegraFormValues,
  regraCreateDefaults,
  regraUpdateDefaults,
  toRegraCreateInput,
  toRegraUpdateInput,
} from "./regras-form-helpers";
import { tipoNoLabel } from "./tipo-no-meta";
import { useRelacionamentosTiposNo } from "@/hooks/relacionamentos/use-relacionamentos-tipos-no";
import type { TipoNoCampo } from "@/lib/api/relacionamentos-tipos-no";
import { DryRunResultPanel } from "./DryRunResultPanel";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Pill } from "@/components/ui/pill";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api/client";
import { useCriarRelacionamentosRegra, useEditarRelacionamentosRegra } from "@/hooks/relacionamentos/use-relacionamentos-regras";
import { useAtivarRegra, useDryRunRegra } from "@/hooks/relacionamentos/use-relacionamentos-dry-run";
import { hashRegraMatching } from "@/lib/api/relacionamentos-regra-hash";
import type {
  DryRunResponse,
  Regra,
  RegraCreateInput,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers de opcoes dos selects (tipos e campos vem do servidor).
// ---------------------------------------------------------------------

interface SelectOption {
  value: string;
  label: string;
}

/**
 * Opcoes do select de campo: colunas reais da tabela_fonte do tipo + o
 * valor atual quando ele nao existe mais na tabela (campo legado fica
 * visivel e sinalizado em vez de sumir silenciosamente do form).
 */
function campoOptions(
  campos: ReadonlyArray<TipoNoCampo>,
  current: string,
): SelectOption[] {
  const opts: SelectOption[] = campos.map((c) => ({
    value: c.campo,
    label: c.campo,
  }));
  if (current && !opts.some((o) => o.value === current)) {
    opts.push({ value: current, label: `${current} (campo inexistente)` });
  }
  if (!current) opts.unshift({ value: "", label: "Selecione…" });
  return opts;
}

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
  const dryRunMutation = useDryRunRegra(regra ? { id: regra.id } : undefined);
  const ativarMutation = useAtivarRegra();
  const { toast } = useToast();

  const pending = createRegra.isPending || editRegra.isPending;

  // Estado local de erro do backend (PT-BR), separado dos erros do zod.
  const [apiError, setApiError] = useState<string | null>(null);

  // Resultado do ultimo dry-run FRESCO (F3). Null enquanto nao simulado.
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);

  // Estado da confirmacao dupla da ativacao (gate S7).
  const [confirmAtivar, setConfirmAtivar] = useState(false);
  const [confirmarEfeito, setConfirmarEfeito] = useState(false);
  const [motivoAtivar, setMotivoAtivar] = useState("");

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
  const campoOrigem = watch("campo_origem");
  const destinoTipo = watch("destino_tipo");
  const campoDestino = watch("campo_destino");
  const combinacao = watch("combinacao");
  const sequencia = watch("sequencia");

  /**
   * Hash dos campos de MATCHING do form ATUAL (gate de frescor E9). Espelha
   * a normalizacao da regra persistida: sequencia so conta em regra composta.
   * Comparado ao `regra_hash` do ultimo dry-run - se divergir, a simulacao
   * esta obsoleta e a ativacao fica bloqueada (o servidor repete o gate).
   */
  const formHash = useMemo(
    () =>
      hashRegraMatching({
        origem_tipo: origemTipo,
        campo_origem: (campoOrigem ?? "").trim(),
        destino_tipo: destinoTipo,
        campo_destino: (campoDestino ?? "").trim(),
        combinacao,
        sequencia:
          combinacao === "composta"
            ? sequencia.map((s) => s.trim()).filter(Boolean)
            : null,
      }),
    [origemTipo, campoOrigem, destinoTipo, campoDestino, combinacao, sequencia],
  );

  /**
   * Tipos de no da org (config_tipos_no) com os campos reais da
   * tabela_fonte de cada um, direto do servidor. Tipo novo cadastrado
   * pelo cockpit aparece aqui sem mexer em codigo.
   */
  const tiposNoQuery = useRelacionamentosTiposNo();
  const tiposNo = useMemo(
    () => tiposNoQuery.data?.tipos ?? [],
    [tiposNoQuery.data],
  );

  /**
   * Opcoes do select de tipo: tipos ativos + o valor atual do form quando
   * ele esta inativo ou nao existe mais (regra legada continua legivel).
   */
  const tipoOptions = useMemo(() => {
    return (current: string): SelectOption[] => {
      const opts = tiposNo
        .filter((t) => t.ativo || t.tipo === current)
        .map((t) => ({ value: t.tipo, label: t.label || tipoNoLabel(t.tipo) }));
      if (current && !opts.some((o) => o.value === current)) {
        opts.push({ value: current, label: tipoNoLabel(current) });
      }
      return opts;
    };
  }, [tiposNo]);

  /**
   * Campos reais do tipo selecionado. Lista vazia (tipo sem tabela_fonte
   * mapeada) degrada o select para input de texto livre.
   */
  const camposOrigem = useMemo(
    () => tiposNo.find((t) => t.tipo === origemTipo)?.campos ?? [],
    [tiposNo, origemTipo],
  );
  const camposDestino = useMemo(
    () => tiposNo.find((t) => t.tipo === destinoTipo)?.campos ?? [],
    [tiposNo, destinoTipo],
  );

  /** Troca de tipo: reseta o campo do lado para a 1a coluna real do tipo. */
  function handleTipoChange(
    lado: "origem" | "destino",
    tipo: string,
    onChange: (value: string) => void,
  ) {
    onChange(tipo);
    const campos = tiposNo.find((t) => t.tipo === tipo)?.campos ?? [];
    setValue(
      lado === "origem" ? "campo_origem" : "campo_destino",
      campos[0]?.campo ?? "",
      { shouldDirty: true, shouldValidate: true },
    );
  }

  /**
   * Hard block: regra simples onde o unico campo destino e `numero_pregao`
   * tem alta taxa de falso positivo. A UI deve impedir o envio; o backend
   * e o trigger SQL repetem o gate. Sem bypass.
   */
  const isHardBlocked =
    combinacao === "simples" && campoDestino === "numero_pregao";

  /** Gate de ativacao (S7) ---------------------------------------------- */

  // A simulacao so faz sentido para uma regra ja salva (tem regra_id).
  const podeTestar = isEdit && Boolean(regra?.id);

  // Dry-run "fresco": existe E seu hash bate com os campos atuais do form.
  const dryRunFresh = dryRun !== null && dryRun.regra_hash === formHash;

  // Bloqueio DURO por risco (limite tecnico => nivel 'bloqueio').
  const bloqueadoPorRisco = dryRun?.score_risco.nivel === "bloqueio";

  // Habilita Ativar apenas com dry-run fresco, sem bloqueio e sem hard-block.
  // Avisos SOFT (nivel='aviso') NAO desabilitam: o humano decide e prossegue.
  const podeAtivar =
    podeTestar && dryRunFresh && !bloqueadoPorRisco && !isHardBlocked;

  // Motivo do bloqueio (title do botao Ativar) quando desabilitado.
  const motivoBloqueio = !podeTestar
    ? "Salve a regra antes de simular e ativar."
    : !dryRun
      ? "Rode a simulação (Testar) antes de ativar."
      : !dryRunFresh
        ? "A regra mudou desde a última simulação. Simule novamente para ativar."
        : bloqueadoPorRisco
          ? "Ativação bloqueada: o limite técnico foi atingido. Ajuste a regra."
          : isHardBlocked
            ? REL_NUMERO_PREGAO_MSG
            : null;

  /** Handlers ------------------------------------------------------------ */

  /** Dispara o dry-run (F3, read-only) da regra salva. */
  async function handleTestar() {
    if (!regra?.id) return;
    setApiError(null);
    try {
      const res = await dryRunMutation.mutateAsync({ id: regra.id });
      setDryRun(res);
    } catch (err) {
      const msg = mapDryRunErrorToPtBr(err);
      setApiError(msg);
      toast({ title: "Erro ao simular regra", description: msg, variant: "danger" });
    }
  }

  /** Abre a confirmacao dupla da ativacao (gate S7). */
  function openConfirmAtivar() {
    setConfirmarEfeito(false);
    setMotivoAtivar("");
    setConfirmAtivar(true);
  }

  /** Confirma a ativacao: dispara o backfill (efeito permanente). */
  async function handleConfirmAtivar() {
    if (!regra?.id || !dryRun) return;
    try {
      const res = await ativarMutation.mutateAsync({
        regra_id: regra.id,
        regra_hash: dryRun.regra_hash,
        confirmar: true,
        confirmar_efeito_permanente: confirmarEfeito,
        motivo: motivoAtivar.trim() || undefined,
      });
      toast({
        title: "Regra ativada",
        description: `Backfill disparado - ${res.arestas_afetadas} aresta(s) afetada(s).`,
        variant: "ok",
      });
      setConfirmAtivar(false);
      setConfirmarEfeito(false);
      setMotivoAtivar("");
    } catch (err) {
      toast({
        title: "Erro ao ativar regra",
        description: mapAtivarErrorToPtBr(err),
        variant: "danger",
      });
    }
  }

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

  // Auto-preenche campo vazio com a 1a coluna real do tipo assim que os
  // tipos carregam do servidor (modo criacao). Nunca sobrescreve valor
  // ja escolhido; tipo sem campos (input livre) fica intocado.
  useEffect(() => {
    if (!campoOrigem && camposOrigem.length > 0) {
      setValue("campo_origem", camposOrigem[0].campo, { shouldValidate: true });
    }
    if (!campoDestino && camposDestino.length > 0) {
      setValue("campo_destino", camposDestino[0].campo, { shouldValidate: true });
    }
  }, [campoOrigem, campoDestino, camposOrigem, camposDestino, setValue]);

  /** Render -------------------------------------------------------------- */

  return (
    <>
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
                onChange={(e) => handleTipoChange("origem", e.target.value, field.onChange)}
              >
                {tipoOptions(field.value).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
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
            render={({ field }) =>
              camposOrigem.length > 0 ? (
                <Select
                  id="regra-campo-origem"
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                >
                  {campoOptions(camposOrigem, field.value).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id="regra-campo-origem"
                  type="text"
                  placeholder="nome_da_coluna"
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              )
            }
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
                onChange={(e) => handleTipoChange("destino", e.target.value, field.onChange)}
              >
                {tipoOptions(field.value).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
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
            render={({ field }) =>
              camposDestino.length > 0 ? (
                <Select
                  id="regra-campo-destino"
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                >
                  {campoOptions(camposDestino, field.value).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id="regra-campo-destino"
                  type="text"
                  placeholder="nome_da_coluna"
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              )
            }
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

      {/* Modo de disparo ---------------------------------------------------- */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="regra-modo-disparo"
          className="text-[12.5px] font-medium text-muted"
        >
          Modo de disparo
        </label>
        <Controller
          control={control}
          name="modo_disparo"
          render={({ field }) => (
            <Select
              id="regra-modo-disparo"
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
            >
              <option value="imediato">Imediato - aplica assim que chega dado novo</option>
              <option value="agendado">Agendado - roda no backfill agendado</option>
              <option value="on-demand">Sob demanda - so roda quando voce dispara</option>
            </Select>
          )}
        />
        <p className="text-[11.5px] text-faint">
          Imediato e Agendado entram no backfill agendado; Sob demanda fica de
          fora do agendado e so roda no dry-run/ativacao manual.
        </p>
      </div>

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
        {podeTestar ? (
          <Button
            type="button"
            variant="default"
            onClick={handleTestar}
            disabled={dryRunMutation.isPending || pending}
            data-btn="regra-testar"
            title="Simula o impacto da regra sem persistir nada."
          >
            {dryRunMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <FlaskConical aria-hidden="true" />
            )}
            <span>{dryRunMutation.isPending ? "Simulando…" : "Testar"}</span>
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          disabled={pending || isHardBlocked}
          data-btn="regra-salvar"
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

    {/* Painel de resultado do dry-run (F3) ------------------------------- */}
    {dryRun ? (
      <div className="mt-4">
        {!dryRunFresh ? (
          <div
            role="status"
            data-msg="dry-run-obsoleto"
            className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn-bg/40 px-3 py-2.5 text-[12.5px] text-fg"
          >
            <TriangleAlert className="mt-0.5 size-4 flex-none text-warn" aria-hidden="true" />
            <span>
              A regra mudou desde esta simulação. Clique em <strong>Testar</strong>{" "}
              novamente para poder ativar.
            </span>
          </div>
        ) : null}
        <DryRunResultPanel
          data={dryRun}
          podeAtivar={podeAtivar}
          motivoBloqueio={motivoBloqueio}
          ativando={ativarMutation.isPending}
          onAtivarClick={openConfirmAtivar}
        />
      </div>
    ) : null}

    {/* Confirmacao dupla da ativacao (gate S7) --------------------------- */}
    <Modal
      open={confirmAtivar}
      onClose={() => setConfirmAtivar(false)}
      title="Ativar regra - efeito permanente"
      description="A ativação dispara o backfill e cria/atualiza arestas no grafo. Esta ação não pode ser desfeita automaticamente."
      width={480}
      closeOnScrim={!ativarMutation.isPending}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmAtivar(false)}
            disabled={ativarMutation.isPending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleConfirmAtivar}
            disabled={!confirmarEfeito || ativarMutation.isPending}
            aria-disabled={!confirmarEfeito || ativarMutation.isPending}
            data-btn="confirmar-ativar-regra"
          >
            {ativarMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            <span>{ativarMutation.isPending ? "Ativando…" : "Confirmar ativação"}</span>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-start gap-2 text-[13px] text-fg">
          <input
            type="checkbox"
            checked={confirmarEfeito}
            onChange={(e) => setConfirmarEfeito(e.target.checked)}
            data-input="confirmar-efeito-permanente"
            className="mt-0.5 size-3.5 accent-[color:var(--accent)]"
          />
          <span>
            Entendo o <strong>efeito permanente</strong> desta ação.
          </span>
        </label>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="ativar-motivo"
            className="text-[12.5px] font-medium text-muted"
          >
            Motivo (opcional)
          </label>
          <Input
            id="ativar-motivo"
            type="text"
            placeholder="ex.: Consolidar vínculos aviso → produto do pregão X"
            value={motivoAtivar}
            onChange={(e) => setMotivoAtivar(e.target.value)}
            data-input="ativar-motivo"
            disabled={ativarMutation.isPending}
          />
          <p className="text-[11.5px] text-faint">
            Registrado na auditoria da ativação.
          </p>
        </div>
      </div>
    </Modal>
    </>
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

/** Erros esperados do dry-run (F3, read-only). */
function mapDryRunErrorToPtBr(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400) return "Não foi possível simular: regra inválida.";
    if (err.status === 404) return "Esta regra não existe mais.";
    return err.message || "Falha na simulação. Tente novamente.";
  }
  return "Falha na simulação. Tente novamente.";
}

/**
 * Erros esperados da guarda de ativacao (gate S7):
 *   422 - confirmacao dupla faltando; 409 - regra mudou desde o dry-run OU
 *   backfill ja em andamento.
 */
function mapAtivarErrorToPtBr(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422)
      return "Confirmação incompleta: marque que entende o efeito permanente.";
    if (err.status === 409)
      return "A regra mudou desde a simulação ou há um backfill em andamento. Simule novamente.";
    if (err.status === 404) return "Esta regra não existe mais.";
    return err.message || "Não foi possível ativar a regra. Tente novamente.";
  }
  return "Não foi possível ativar a regra. Tente novamente.";
}
