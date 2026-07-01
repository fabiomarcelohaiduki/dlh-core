"use client";

// =====================================================================
// RelacionamentosParametrosView - sub-secao E do painel de
// Relacionamentos: formulario de configuracao singleton
// (config_relacionamentos) e gestao dos tipos de no (config_tipos_no).
//
// Estrutura:
//   1) Card de nota sobre calibragem empirica (sempre visivel);
//   2) Formulario da config singleton com 7 campos editaveis
//      (uso_minimo_promocao_alternativa, dois_caminhos_minimo,
//       uso_minimo_promocao, cap_panorama, cap_vizinhanca,
//       profundidade_max_lia, profundidade_default_panorama);
//   3) Secao "Tipos de no": lista os 10 tipos atuais com label, icone,
//      cor (swatch DLH4), ordem e ativo; permite editar.
//
// Validacao:
//   - configUpdateSchema via zodResolver (espelho client-side do
//     backend);
//   - bloqueia envio durante submit (campos desabilitados + spinner);
//   - toasts verde/erro PT-BR;
//   - tipos de no com ativo=false nao devem aparecer no grafo (UI
//     sinaliza com Pill neutra "inativo"; RNF-15).
//
// Icones: o campo `icone` armazena o nome de um componente lucide-react
// (ex.: "Bell", "Workflow"). Resolvemos dinamicamente via mapa
// explicito do namespace lucide-react para evitar carregar tudo.
// =====================================================================

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  CircleAlert,
  Info,
  Loader2,
  Pencil,
  Save,
  TriangleAlert,
} from "lucide-react";
import * as LucideIcons from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { Toggle } from "@/components/ui/toggle";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api/client";
import { configUpdateSchema } from "@/lib/api/relacionamentos-zod";
import {
  useRelacionamentosConfig,
  useUpdateRelacionamentosConfig,
  useRelacionamentosTipos,
  useUpsertRelacionamentosTipo,
} from "@/hooks/relacionamentos/use-relacionamentos-config";
import type {
  ConfigRelacionamentos,
  ConfigRelacionamentosUpdateInput,
  ConfigTipoNo,
  ConfigTipoNoUpdateInput,
  RelacionamentoTipoNo,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Labels PT-BR para os 10 tipos atuais (espelham config_tipos_no seed).
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

const TIPOS_MVP: ReadonlyArray<RelacionamentoTipoNo> = [
  "aviso",
  "processo",
  "documento",
  "pessoa",
  "produto",
  "linha",
  "sku",
  "preco",
  "politica",
  "cotacao_diretriz",
];

// ---------------------------------------------------------------------
// Tipos locais.
// ---------------------------------------------------------------------

/** Valores tipados do formulario de configuracao. */
interface ConfigFormValues {
  uso_minimo_promocao_alternativa: number;
  dois_caminhos_minimo: number;
  uso_minimo_promocao: number;
  cap_panorama: number | null;
  cap_vizinhanca: number;
  profundidade_max_lia: number;
  profundidade_default_panorama: number;
}

/** Valores do sub-formulario de tipo de no. */
interface TipoFormValues {
  tipo: RelacionamentoTipoNo;
  label: string;
  icone: string;
  cor: string;
  ordem: number;
  ativo: boolean;
}

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

/** Defaults para o formulario de configuracao a partir do singleton. */
function configDefaults(cfg: ConfigRelacionamentos | undefined): ConfigFormValues {
  if (!cfg) {
    return {
      uso_minimo_promocao_alternativa: 0,
      dois_caminhos_minimo: 0,
      uso_minimo_promocao: 0,
      cap_panorama: null,
      cap_vizinhanca: 50,
      profundidade_max_lia: 3,
      profundidade_default_panorama: 2,
    };
  }
  return {
    uso_minimo_promocao_alternativa: cfg.uso_minimo_promocao_alternativa,
    dois_caminhos_minimo: cfg.dois_caminhos_minimo,
    uso_minimo_promocao: cfg.uso_minimo_promocao,
    cap_panorama: cfg.cap_panorama,
    cap_vizinhanca: cfg.cap_vizinhanca,
    profundidade_max_lia: cfg.profundidade_max_lia,
    profundidade_default_panorama: cfg.profundidade_default_panorama,
  };
}

/** Defaults para o sub-formulario de tipo de no. */
function tipoDefaults(
  tipo: ConfigTipoNo | null,
  fallback: RelacionamentoTipoNo,
): TipoFormValues {
  if (!tipo) {
    return {
      tipo: fallback,
      label: TIPO_NO_LABEL[fallback],
      icone: "Circle",
      cor: "#71717a",
      ordem: 0,
      ativo: true,
    };
  }
  return {
    tipo: tipo.tipo,
    label: tipo.label,
    icone: tipo.icone,
    cor: tipo.cor,
    ordem: tipo.ordem,
    ativo: tipo.ativo,
  };
}

/** Resolve dinamicamente um componente de icone pelo nome (lucide-react). */
function resolveIcone(
  nome: string,
): React.ComponentType<{ className?: string }> {
  const icons = LucideIcons as unknown as Record<
    string,
    React.ComponentType<{ className?: string }>
  >;
  return icons[nome] ?? icons[toPascalIconName(nome)] ?? IconsFallback;
}

/** Converte slugs do seed ("file-text") para nomes lucide ("FileText"). */
function toPascalIconName(nome: string): string {
  return nome
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((parte) => parte.charAt(0).toUpperCase() + parte.slice(1))
    .join("");
}

const IconsFallback: React.ComponentType<{ className?: string }> = ({
  className,
}) => <CircleAlert className={className} aria-hidden="true" />;

/** Lista de icones lucide sugeridos por tipo. */
const ICONES_SUGERIDOS: Record<RelacionamentoTipoNo, string[]> = {
  aviso: ["Bell", "Mail", "FileText"],
  processo: ["Workflow", "GitBranch", "Gavel"],
  documento: ["FileText", "File", "Paperclip"],
  pessoa: ["User", "Users", "UserCircle"],
  produto: ["Package", "Box", "ShoppingBag"],
  linha: ["Layers", "Tag", "FolderTree"],
  sku: ["Hash", "Barcode", "Boxes"],
  preco: ["BadgeDollarSign", "DollarSign", "Calculator"],
  politica: ["ShieldCheck", "Gavel", "ListChecks"],
  cotacao_diretriz: ["ScrollText", "FileText", "ClipboardList"],
};

/** Paleta DLH4 (espelha o seed canonico). */
const CORES_DLH4: ReadonlyArray<{ hex: string; nome: string }> = [
  { hex: "#e27300", nome: "ambar" },
  { hex: "#facc15", nome: "amarelo" },
  { hex: "#22c55e", nome: "verde" },
  { hex: "#3b82f6", nome: "azul" },
  { hex: "#a855f7", nome: "roxo" },
  { hex: "#ec4899", nome: "rosa" },
  { hex: "#71717a", nome: "cinza" },
];

/** Mapeia erro do backend em PT-BR. */
function mapApiErrorToPtBr(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400) return "Dados inválidos: revise os campos.";
    if (err.status === 404) return "Config não encontrada.";
    if (err.status === 409)
      return "Conflito: a config mudou durante a operação.";
    if (err.status === 422)
      return "Operação inválida: confira os valores numéricos.";
    return err.message || "Não foi possível salvar. Tente novamente.";
  }
  return "Não foi possível salvar. Tente novamente.";
}

// ---------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------

export function RelacionamentosParametrosView() {
  const config = useRelacionamentosConfig();
  const updateConfig = useUpdateRelacionamentosConfig();
  const tiposQuery = useRelacionamentosTipos();
  const upsertTipo = useUpsertRelacionamentosTipo();
  const { toast } = useToast();

  const [editingTipo, setEditingTipo] = useState<ConfigTipoNo | null>(null);
  // Alvo explicito quando o usuario abre o modal a partir do aviso "Tipo
  // nao cadastrado - cadastre em Parametros" de uma chave alem dos 7 MVP.
  const [editingAlvo, setEditingAlvo] = useState<RelacionamentoTipoNo | null>(
    null,
  );

  return (
    <>
      {/* Nota sobre calibragem ------------------------------------------- */}
      <section
        data-card="nota-calibragem"
        role="note"
        className="flex items-start gap-2 rounded-md border border-accent/40 bg-accent-soft/30 p-3"
      >
        <Info className="mt-0.5 size-4 flex-none text-accent" aria-hidden="true" />
        <p className="m-0 text-[12.5px] text-fg">
          <strong>Calibragem final será empírica</strong> (volume de candidatos,
          taxa de aprovação humana, falso positivo). Ajuste os limiares
          gradualmente conforme a org valida as sugestões da Lia.
        </p>
      </section>

      {/* Formulario de configuracao singleton --------------------------- */}
      {config.isError ? (
        <WidgetErrorLocal
          title="Não foi possível carregar a configuração"
          message={humanizarErro(config.error)}
          onRetry={() => config.refetch()}
        />
      ) : config.isLoading || !config.data ? (
        <ConfigFormSkeleton />
      ) : (
        <div
          id="parametros-form"
          data-anchor="parametros-form"
          className="contents"
        >
        <ConfigForm
          cfg={config.data}
          isPending={updateConfig.isPending}
          onSave={async (input) => {
            try {
              await updateConfig.mutateAsync(input);
              toast({ title: "Configuração salva", variant: "ok" });
            } catch (err) {
              const msg = mapApiErrorToPtBr(err);
              toast({
                title: "Erro ao salvar configuração",
                description: msg,
                variant: "danger",
              });
            }
          }}
        />
        </div>
      )}

      {/* Secao de tipos de no ------------------------------------------- */}
      <section
        data-card="tipos-no"
        aria-labelledby="tipos-no-titulo"
        className="flex flex-col gap-3"
      >
        <header className="flex items-center justify-between gap-2">
          <h3
            id="tipos-no-titulo"
            className="flex items-center gap-2 text-[14px] font-semibold text-fg"
          >
            <Boxes className="size-4" aria-hidden="true" />
            <span>Tipos de nó</span>
          </h3>
          <Pill variant="neutral" dot>
            {tiposQuery.data?.items.length ?? 0} de {TIPOS_MVP.length} cadastrados
          </Pill>
        </header>

        <p className="m-0 text-[12.5px] text-muted">
          Edita a paleta canonica oficial (DLH4) usada pelo grafo. Tipos
          inativos nao aparecem no grafo (RNF-15). Tipos nao cadastrados
          alem dos 7 MVP sao placeholder neutro com aviso para cadastrar
          em Parametros (RNF-15).
        </p>

        {tiposQuery.isError ? (
          <WidgetErrorLocal
            title="Não foi possível carregar os tipos de nó"
            message={humanizarErro(tiposQuery.error)}
            onRetry={() => tiposQuery.refetch()}
          />
        ) : tiposQuery.isLoading ? (
          <TiposSkeleton />
        ) : (
          <TiposNoLista
            tipos={tiposQuery.data?.items ?? []}
            onEdit={(tipo, alvo) => {
              setEditingTipo(tipo);
              setEditingAlvo(alvo ?? null);
            }}
          />
        )}
      </section>

      {/* Modal de edicao de tipo de no ---------------------------------- */}
      <TipoNoEditModal
        open={Boolean(editingTipo) || editingAlvo !== null}
        tipo={editingTipo}
        alvoInicial={editingAlvo}
        onClose={() => {
          setEditingTipo(null);
          setEditingAlvo(null);
        }}
        onSave={async (input) => {
          try {
            await upsertTipo.mutateAsync(input);
            toast({ title: "Tipo de nó atualizado", variant: "ok" });
            setEditingTipo(null);
            setEditingAlvo(null);
          } catch (err) {
            const msg = mapApiErrorToPtBr(err);
            toast({
              title: "Erro ao salvar tipo de nó",
              description: msg,
              variant: "danger",
            });
          }
        }}
        isPending={upsertTipo.isPending}
      />
    </>
  );
}

// ---------------------------------------------------------------------
// Sub-componente: formulario de configuracao.
// ---------------------------------------------------------------------

function ConfigForm({
  cfg,
  onSave,
  isPending,
}: {
  cfg: ConfigRelacionamentos;
  onSave: (input: ConfigRelacionamentosUpdateInput) => Promise<void>;
  isPending: boolean;
}) {
  const defaults = useMemo(() => configDefaults(cfg), [cfg]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<ConfigFormValues>({
    // O zodResolver aceita o configUpdateSchema diretamente, mas a forma
    // dos campos difere um pouco (no schema, cap_panorama aceita null).
    // Cast para never evita friccao com o tipo de input do RHF.
    resolver: zodResolver(configUpdateSchema) as never,
    defaultValues: defaults,
    mode: "onChange",
  });

  // Reaplica defaults se a config mudar apos o primeiro carregamento
  // (ex.: seed do backend que chega com valores reais).
  useEffect(() => {
    reset(defaults);
  }, [defaults, reset]);

  async function onSubmit(values: ConfigFormValues) {
    const input: ConfigRelacionamentosUpdateInput = {};
    if (values.uso_minimo_promocao_alternativa !== defaults.uso_minimo_promocao_alternativa) {
      input.uso_minimo_promocao_alternativa =
        values.uso_minimo_promocao_alternativa;
    }
    if (values.dois_caminhos_minimo !== defaults.dois_caminhos_minimo) {
      input.dois_caminhos_minimo = values.dois_caminhos_minimo;
    }
    if (values.uso_minimo_promocao !== defaults.uso_minimo_promocao) {
      input.uso_minimo_promocao = values.uso_minimo_promocao;
    }
    if (values.cap_panorama !== defaults.cap_panorama) {
      input.cap_panorama = values.cap_panorama;
    }
    if (values.cap_vizinhanca !== defaults.cap_vizinhanca) {
      input.cap_vizinhanca = values.cap_vizinhanca;
    }
    if (values.profundidade_max_lia !== defaults.profundidade_max_lia) {
      input.profundidade_max_lia = values.profundidade_max_lia;
    }
    if (
      values.profundidade_default_panorama !==
      defaults.profundidade_default_panorama
    ) {
      input.profundidade_default_panorama =
        values.profundidade_default_panorama;
    }
    await onSave(input);
  }

  return (
    <form
      data-form="parametros-relacionamentos"
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="flex flex-col gap-4 rounded-md border border-border bg-surface-2/40 p-4"
    >
      <h3 className="text-[14px] font-semibold text-fg">Limiares e limites</h3>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <FieldNumero
          id="cfg-uso-min-alternativa"
          label="Uso mínimo sozinho"
          help="Marca pronta quando o uso sozinho atinge este valor."
          min={0}
          error={errors.uso_minimo_promocao_alternativa?.message}
          disabled={isPending}
          {...register("uso_minimo_promocao_alternativa", {
            valueAsNumber: true,
          })}
        />
        <FieldNumero
          id="cfg-dois-caminhos"
          label="2 caminhos mínimo"
          help="Confirmações mínimas quando a promoção depende de uso + 2 caminhos."
          min={0}
          error={errors.dois_caminhos_minimo?.message}
          disabled={isPending}
          {...register("dois_caminhos_minimo", { valueAsNumber: true })}
        />
        <FieldNumero
          id="cfg-uso-min"
          label="Uso mínimo com 2 caminhos"
          help="Uso mínimo exigido junto com o limite de 2 caminhos."
          min={0}
          error={errors.uso_minimo_promocao?.message}
          disabled={isPending}
          {...register("uso_minimo_promocao", { valueAsNumber: true })}
        />
        <FieldNumero
          id="cfg-cap-panorama"
          label="Cap do panorama"
          help="Teto de nós exibidos no panorama. Vazio = sem teto."
          min={1}
          allowNull
          error={errors.cap_panorama?.message}
          disabled={isPending}
          {...register("cap_panorama", {
            setValueAs: (v: string) =>
              v === "" || v === null || v === undefined ? null : Number(v),
          })}
        />
        <FieldNumero
          id="cfg-cap-vizinhanca"
          label="Cap da vizinhança"
          help="Teto de vizinhos retornados pela travessia (mínimo 1)."
          min={1}
          error={errors.cap_vizinhanca?.message}
          disabled={isPending}
          {...register("cap_vizinhanca", { valueAsNumber: true })}
        />
        <FieldNumero
          id="cfg-profundidade-max-lia"
          label="Profundidade máx. Lia"
          help="Profundidade máxima permitida para a Lia (1..5)."
          min={1}
          max={5}
          error={errors.profundidade_max_lia?.message}
          disabled={isPending}
          {...register("profundidade_max_lia", { valueAsNumber: true })}
        />
        <FieldNumero
          id="cfg-profundidade-default"
          label="Profundidade padrão panorama"
          help="Profundidade inicial do panorama (1..5)."
          min={1}
          max={5}
          error={errors.profundidade_default_panorama?.message}
          disabled={isPending}
          {...register("profundidade_default_panorama", {
            valueAsNumber: true,
          })}
        />
      </div>

      {/* Footer do form */}
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        {!isDirty ? (
          <span className="mr-auto text-[11.5px] text-faint">
            Sem alterações pendentes.
          </span>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          disabled={isPending || !isDirty}
          aria-disabled={isPending || !isDirty}
          data-btn="salvar-parametros"
        >
          {isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Save aria-hidden="true" />
          )}
          <span>{isPending ? "Salvando…" : "Salvar"}</span>
        </Button>
      </footer>
    </form>
  );
}

// ---------------------------------------------------------------------
// Sub-componente: campo de numero com label + help + erro.
// ---------------------------------------------------------------------

interface FieldNumeroProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  id: string;
  label: string;
  help?: string;
  error?: string;
  allowNull?: boolean;
}

const FieldNumero = React.forwardRef<HTMLInputElement, FieldNumeroProps>(
  ({ id, label, help, error, allowNull, disabled, ...rest }, ref) => {
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-[12.5px] font-medium text-muted">
          {label}
          {allowNull ? (
            <span className="ml-1 text-[11px] text-faint">(vazio = sem teto)</span>
          ) : null}
        </label>
        <Input
          id={id}
          ref={ref}
          type="number"
          inputMode="numeric"
          disabled={disabled}
          state={error ? "error" : "default"}
          aria-invalid={error ? true : undefined}
          {...rest}
        />
        {help ? <p className="text-[11.5px] text-faint">{help}</p> : null}
        {error ? (
          <p className="flex items-center gap-1 text-[11.5px] text-err">
            <TriangleAlert className="size-3" aria-hidden="true" />
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
FieldNumero.displayName = "FieldNumero";

// ---------------------------------------------------------------------
// Sub-componente: lista de tipos de no.
// ---------------------------------------------------------------------

function TiposNoLista({
  tipos,
  onEdit,
}: {
  tipos: ConfigTipoNo[];
  onEdit: (
    tipo: ConfigTipoNo | null,
    alvo?: RelacionamentoTipoNo,
  ) => void;
}) {
  // Index por tipo para lookup rapido.
  const index = useMemo(() => {
    const m = new Map<RelacionamentoTipoNo, ConfigTipoNo>();
    for (const t of tipos) m.set(t.tipo, t);
    return m;
  }, [tipos]);

  // Tipos a renderizar = TIPOS_MVP uniao com quaisquer tipos extras que
  // aparecam no backend (alem dos 7). Para tipos fora do MVP usamos o
  // proprio identificador como chave de UI (RNF-15).
  const tiposRenderizados = useMemo<ReadonlyArray<RelacionamentoTipoNo>>(() => {
    const mvpSet = new Set<RelacionamentoTipoNo>(TIPOS_MVP);
    const extras: RelacionamentoTipoNo[] = [];
    for (const t of tipos) {
      if (!mvpSet.has(t.tipo)) extras.push(t.tipo);
    }
    return [...TIPOS_MVP, ...extras];
  }, [tipos]);

  return (
    <ul
      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      data-list="tipos-no"
    >
      {tiposRenderizados.map((tipo) => {
        const t = index.get(tipo) ?? null;
        const Ico = t ? resolveIcone(t.icone) : null;
        return (
          <li
            key={tipo}
            data-row-tipo-no={tipo}
            data-cadastrado={t ? "true" : "false"}
            data-ativo={t?.ativo ? "true" : "false"}
            data-placeholder={t ? "false" : "true"}
            className={cn(
              "flex items-center justify-between gap-3 rounded-md border bg-surface px-3 py-2.5",
              t?.ativo === false
                ? "border-border-soft bg-surface-2/30"
                : "border-border",
              !t && "border-dashed border-border-soft bg-surface-2/40",
            )}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              {t ? (
                <span
                  className="grid size-7 flex-none place-items-center rounded-md"
                  style={{
                    background: t.cor,
                    color: "#fff",
                    boxShadow: `0 0 6px color-mix(in srgb, ${t.cor} 35%, transparent)`,
                  }}
                  aria-hidden="true"
                >
                  {Ico ? <Ico className="size-3.5" /> : null}
                </span>
              ) : (
                <span
                  className="grid size-7 flex-none place-items-center rounded-md border border-dashed border-border bg-surface-2 text-faint"
                  aria-hidden="true"
                >
                  <CircleAlert className="size-3.5" />
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-fg">
                  {t?.label ?? TIPO_NO_LABEL[tipo] ?? tipo}
                </p>
                {t ? (
                  <p className="truncate font-mono text-[11px] text-faint">
                    {`${t.icone} · ${t.cor} · ordem ${t.ordem}`}
                  </p>
                ) : (
                  <p
                    className="m-0 text-[11.5px] text-warn"
                    data-msg="tipo-nao-cadastrado"
                    data-msg-full="Tipo nao cadastrado - cadastre em Parametros"
                  >
                    {/* Aviso RNF-15: tipos nao cadastrados alem dos 7 MVP */}
                    Tipo nao cadastrado - cadastre em{" "}
                    <a
                      href={`#parametros-form`}
                      data-link="cadastrar-tipo-no"
                      className="underline hover:no-underline"
                      onClick={(e) => {
                        // Abre o modal de edicao pre-populado com o
                        // tipo alvo desta linha (RNF-15: tipos nao
                        // cadastrados alem dos 7 MVP devem oferecer uma
                        // acao clara para o usuario cadastra-los).
                        e.preventDefault();
                        onEdit(null, tipo);
                      }}
                    >
                      Parametros
                    </a>
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {t?.ativo === false ? (
                <Pill variant="warn" dot>
                  inativo
                </Pill>
              ) : !t ? (
                <Pill variant="neutral" dot>
                  não cadastrado
                </Pill>
              ) : (
                <Pill variant="ok" dot>
                  ativo
                </Pill>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onEdit(t ?? null, tipo)}
                aria-label={`Editar tipo de nó ${TIPO_NO_LABEL[tipo] ?? tipo}`}
                data-btn={`editar-tipo-no-${tipo}`}
              >
                <Pencil aria-hidden="true" />
                <span>Editar</span>
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------
// Sub-componente: modal de edicao de tipo de no.
// ---------------------------------------------------------------------

function TipoNoEditModal({
  open,
  tipo,
  alvoInicial,
  onClose,
  onSave,
  isPending,
}: {
  open: boolean;
  tipo: ConfigTipoNo | null;
  /** Tipo alvo quando o modal abre a partir do aviso "Tipo nao
   *  cadastrado - cadastre em Parametros" de uma chave alem dos 7 MVP. */
  alvoInicial?: RelacionamentoTipoNo | null;
  onClose: () => void;
  onSave: (input: ConfigTipoNoUpdateInput) => Promise<void>;
  isPending: boolean;
}) {
  // Resolucao do alvo: usa o `tipo` existente se houver; senao cai no
  // `alvoInicial` (passado pela lista quando o usuario clica no link
  // "cadastre em Parametros"); senao usa "aviso" como default conservador.
  const resolveAlvoInicial = (): RelacionamentoTipoNo =>
    tipo?.tipo ?? alvoInicial ?? "aviso";

  // O tipo alvo (selecionado da lista; pode ser null para um novo).
  const [tipoAlvo, setTipoAlvo] = useState<RelacionamentoTipoNo>(
    resolveAlvoInicial(),
  );

  useEffect(() => {
    if (open) {
      setTipoAlvo(resolveAlvoInicial());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tipo, alvoInicial]);

  const alvo = useMemo<RelacionamentoTipoNo>(
    () => tipoAlvo,
    [tipoAlvo],
  );

  const defaults = useMemo(() => tipoDefaults(tipo, alvo), [tipo, alvo]);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { isDirty, errors },
  } = useForm<TipoFormValues>({
    defaultValues: defaults,
    mode: "onChange",
  });

  useEffect(() => {
    if (open) {
      reset(defaults);
    }
  }, [open, defaults, reset]);

  const iconeAtual = watch("icone");
  const corAtual = watch("cor");
  const ativoAtual = watch("ativo");
  const IcoPreview = resolveIcone(iconeAtual);

  async function onSubmit(values: TipoFormValues) {
    const input: ConfigTipoNoUpdateInput = {
      ...(tipo ? { id: tipo.id } : {}),
      tipo: alvo,
      label: values.label.trim(),
      icone: values.icone.trim(),
      cor: values.cor.trim(),
      ordem: values.ordem,
      ativo: values.ativo,
    };
    await onSave(input);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tipo ? "Editar tipo de nó" : "Novo tipo de nó"}
      description="Ajuste label, ícone, cor, ordem e visibilidade deste tipo no grafo."
      width={560}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isPending}
            data-btn="cancelar-tipo-no"
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            form="tipo-no-form"
            variant="primary"
            disabled={isPending || !isDirty}
            data-btn="salvar-tipo-no"
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save aria-hidden="true" />
            )}
            <span>{isPending ? "Salvando…" : "Salvar"}</span>
          </Button>
        </>
      }
    >
      <form
        id="tipo-no-form"
        data-form="tipo-no"
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="flex flex-col gap-3"
      >
        {/* Tipo (alvo) ------------------------------------------------- */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="tipo-no-tipo"
            className="text-[12.5px] font-medium text-muted"
          >
            Tipo
          </label>
          <select
            id="tipo-no-tipo"
            value={alvo}
            onChange={(e) => {
              const novoTipo = e.target.value as RelacionamentoTipoNo;
              setTipoAlvo(novoTipo);
              // Reset minimo para refletir o tipo escolhido.
              reset({
                tipo: novoTipo,
                label: TIPO_NO_LABEL[novoTipo],
                icone: ICONES_SUGERIDOS[novoTipo]?.[0] ?? "Circle",
                cor: CORES_DLH4[0]?.hex ?? "#71717a",
                ordem: defaults.ordem,
                ativo: true,
              });
            }}
            className={cn(
              "h-10 rounded-sm border border-border bg-surface-2 px-3 text-[13.5px] text-fg",
              "focus-visible:border-accent-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
            )}
            disabled={Boolean(tipo)}
          >
            {TIPOS_MVP.map((t) => (
              <option key={t} value={t}>
                {TIPO_NO_LABEL[t]}
              </option>
            ))}
          </select>
          {tipo ? (
            <p className="text-[11.5px] text-faint">
              Identificador do tipo não pode ser alterado após cadastro.
            </p>
          ) : null}
        </div>

        {/* Label ------------------------------------------------------- */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="tipo-no-label"
            className="text-[12.5px] font-medium text-muted"
          >
            Label
          </label>
          <Input
            id="tipo-no-label"
            type="text"
            placeholder="ex.: Aviso"
            {...register("label")}
          />
          {errors.label ? (
            <p className="flex items-center gap-1 text-[11.5px] text-err">
              <TriangleAlert className="size-3" aria-hidden="true" />
              {errors.label.message as string}
            </p>
          ) : null}
        </div>

        {/* Icone + Cor ------------------------------------------------- */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="tipo-no-icone"
              className="text-[12.5px] font-medium text-muted"
            >
              Ícone (lucide)
            </label>
            <Input
              id="tipo-no-icone"
              type="text"
              placeholder="ex.: Bell"
              list={`icones-${alvo}`}
              {...register("icone")}
            />
            <datalist id={`icones-${alvo}`}>
              {(ICONES_SUGERIDOS[alvo] ?? []).map((i) => (
                <option key={i} value={i} />
              ))}
            </datalist>
            <p className="text-[11.5px] text-faint">
              Pré-visualização:
              <span className="ml-2 inline-flex items-center gap-1">
                <IcoPreview className="size-3.5" aria-hidden="true" />
                <span className="font-mono text-[10.5px]">{iconeAtual}</span>
              </span>
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="tipo-no-cor"
              className="text-[12.5px] font-medium text-muted"
            >
              Cor (hex DLH4)
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="tipo-no-cor"
                type="text"
                placeholder="#e27300"
                className="flex-1"
                {...register("cor")}
              />
              <span
                aria-hidden="true"
                className="grid size-7 flex-none place-items-center rounded-md border border-border text-white"
                style={{ background: corAtual }}
              >
                <IcoPreview className="size-3.5" />
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {CORES_DLH4.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  onClick={() =>
                    setValue("cor", c.hex, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                  className={cn(
                    "size-5 rounded-md border border-border transition-transform hover:scale-110",
                    corAtual === c.hex && "ring-2 ring-accent-line",
                  )}
                  style={{ background: c.hex }}
                  aria-label={`Cor ${c.nome} (${c.hex})`}
                  title={c.nome}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Ordem + Ativo ---------------------------------------------- */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="tipo-no-ordem"
              className="text-[12.5px] font-medium text-muted"
            >
              Ordem
            </label>
            <Input
              id="tipo-no-ordem"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              {...register("ordem", { valueAsNumber: true })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-muted">Ativo</span>
            <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
              <Toggle
                checked={Boolean(ativoAtual)}
                onChange={(next) =>
                  setValue("ativo", next, { shouldDirty: true })
                }
                ariaLabel={`Ativar tipo de nó ${alvo}`}
              />
              <span className="text-[12.5px] text-muted">
                {ativoAtual
                  ? "Visível no grafo"
                  : "Oculto do grafo (placeholder neutro)"}
              </span>
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Sub-componentes: skeletons de carregamento.
// ---------------------------------------------------------------------

function ConfigFormSkeleton() {
  return (
    <div
      data-loading-config
      aria-busy="true"
      aria-live="polite"
      className="flex flex-col gap-4 rounded-md border border-border bg-surface-2/40 p-4"
    >
      <span className="block h-4 w-1/3 animate-pulse rounded-sm bg-surface-3" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <span className="block h-3 w-1/2 animate-pulse rounded-sm bg-surface-3" />
            <span className="block h-10 w-full animate-pulse rounded-sm bg-surface-3" />
          </div>
        ))}
      </div>
    </div>
  );
}

function TiposSkeleton() {
  return (
    <ul
      aria-busy="true"
      aria-live="polite"
      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
    >
      {Array.from({ length: 7 }).map((_, i) => (
        <li
          key={i}
          className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2.5"
        >
          <div className="flex items-center gap-2.5">
            <span className="block size-7 animate-pulse rounded-md bg-surface-3" />
            <div className="flex flex-col gap-1">
              <span className="block h-3 w-20 animate-pulse rounded-sm bg-surface-3" />
              <span className="block h-2.5 w-32 animate-pulse rounded-sm bg-surface-3" />
            </div>
          </div>
          <span className="block h-6 w-14 animate-pulse rounded-sm bg-surface-3" />
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------
// WidgetError local (espelha o componente compartilhado para evitar
// dependencia circular no carregamento deste arquivo).
// ---------------------------------------------------------------------

function WidgetErrorLocal({
  title = "Não foi possível carregar",
  message = "Ocorreu uma falha ao buscar os dados. Tente novamente.",
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-err/40 bg-err-bg/30 p-4 text-center">
      <TriangleAlert className="size-5 text-err" aria-hidden="true" />
      <p className="text-[13px] font-semibold text-fg">{title}</p>
      <p className="text-[12.5px] text-muted">{message}</p>
      {onRetry ? (
        <Button type="button" variant="default" size="sm" onClick={onRetry}>
          Tentar novamente
        </Button>
      ) : null}
    </div>
  );
}

function humanizarErro(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "Recurso nao encontrado.";
    if (err.status === 409) return "Conflito com o estado atual.";
    if (err.status === 422) return "Dados invalidos: revise os valores.";
    return err.message || "Falha na operacao. Tente novamente.";
  }
  return "Falha na operacao. Tente novamente.";
}
