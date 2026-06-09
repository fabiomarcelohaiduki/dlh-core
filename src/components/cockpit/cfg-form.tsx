"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useSalvarConfig } from "@/hooks/use-admin";
import { useExecucoes } from "@/hooks/use-monitoring";
import { ConfigSectionHeading } from "@/components/cockpit/source-card";
import { hasRunningExecucao } from "@/lib/status";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ConfigIngestaoState } from "@/lib/api/types";

const MIN_JANELA = 1;
const MAX_JANELA = 365;

/**
 * Modalidades do Effecti que entram na allowlist da ingestao. O `value` casa
 * EXATAMENTE com o campo `modalidade` retornado pela API (effecti-connector
 * filtra por igualdade de texto). Marcado = no filtro; vazio = todas.
 */
const MODALIDADES = [
  "Pregão Eletrônico",
  "Pregão Presencial",
  "Dispensa",
  "Concorrência",
  "Cotação Eletrônica",
  "Outros",
].map((value) => ({ value, label: value }));

/**
 * Portais do Effecti que entram na allowlist da ingestao. O `value` casa
 * EXATAMENTE com o campo `portal` retornado pela API (effecti-connector filtra
 * por igualdade). Marcado = no filtro; desmarcado = excluido da coleta. BBMNet
 * fica de fora da lista por decisao do produto (nao ingerir).
 */
const PORTAIS = [
  "ComprasNet",
  "Compras Públicas",
  "BNC - Bolsa Nacional de Compras",
  "BLL - Bolsa de Licitações e Leilões",
  "Licitar Digital",
  "Licitanet",
  "Banrisul",
  "ComprasRS",
  "Compras Minas Gerais",
].map((value) => ({ value, label: value }));

/**
 * Schema cliente (espelha ingestaoConfigSchema do backend): janelaDias inteiro
 * em [1, 365]; modalidades/portais com ao menos um item. Rejeita 0/negativa/
 * acima do maximo e listas vazias ANTES do submit (criterio 4.5.1).
 */
const cfgSchema = z.object({
  janelaDias: z
    .number({ invalid_type_error: "Informe um número." })
    .int("Use um número inteiro de dias.")
    .min(MIN_JANELA, `Informe um valor entre ${MIN_JANELA} e ${MAX_JANELA} dias.`)
    .max(MAX_JANELA, `Informe um valor entre ${MIN_JANELA} e ${MAX_JANELA} dias.`),
  // modalidades e allowlist por igualdade de texto; vazio = todas as modalidades.
  modalidades: z.array(z.string()),
  portais: z.array(z.string()).min(1, "Selecione ao menos um portal."),
});
type CfgValues = z.infer<typeof cfgSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

function toDefaults(initial: ConfigIngestaoState): CfgValues {
  return {
    janelaDias: initial.janelaDias,
    modalidades: initial.modalidades,
    portais: initial.portais.length ? initial.portais : PORTAIS.map((p) => p.value),
  };
}

/**
 * cmp-cfg-form — Configuracao da ingestao (US-03, US-20).
 *
 * Estados idle/success/error. action-salvar-cfg (useSalvarConfig -> PUT config)
 * persiste e VALE NA PROXIMA EXECUCAO, sem redeploy e sem afetar a coleta
 * atual. O disparo manual vive no bloco "Coleta manual" (cmp-effecti-disparo-
 * form), acima; este form so reporta o estado `dirty` (onDirtyChange) para que
 * aquele bloco avise sobre alteracoes nao salvas antes de disparar.
 */
export function CfgForm({
  initial,
  onDirtyChange,
}: {
  initial: ConfigIngestaoState;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const salvar = useSalvarConfig();
  const execucoes = useExecucoes({ limit: 50 });

  const running = hasRunningExecucao(execucoes.data?.items, "effecti");

  const [saveFeedback, setSaveFeedback] = useState<Feedback | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty, isSubmitted },
  } = useForm<CfgValues>({
    resolver: zodResolver(cfgSchema),
    defaultValues: toDefaults(initial),
  });

  // Sobe o estado "alteracoes nao salvas" para o painel pai, que repassa ao
  // bloco de coleta manual (aviso antes de disparar com config pendente).
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const modalidades = watch("modalidades");
  const portais = watch("portais");

  function toggle(field: "modalidades" | "portais", value: string, checked: boolean) {
    const current = field === "modalidades" ? modalidades : portais;
    const next = checked
      ? Array.from(new Set([...current, value]))
      : current.filter((v) => v !== value);
    setValue(field, next, { shouldDirty: true, shouldValidate: isSubmitted });
    setSaveFeedback(null);
  }

  async function onSubmit(values: CfgValues) {
    setSaveFeedback(null);
    try {
      await salvar.mutateAsync({
        janelaDias: values.janelaDias,
        modalidades: values.modalidades,
        portais: values.portais,
      });
      // reset(values) limpa o estado "sujo" mantendo os valores salvos.
      reset(values);
      setSaveFeedback({
        kind: "ok",
        message: running
          ? "Configuração salva · vale na próxima execução (a coleta atual não é afetada)"
          : "Configuração salva · vale na próxima execução",
      });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 400
          ? "Dados inválidos: revise a janela e as seleções."
          : "Não foi possível salvar a configuração. Tente novamente.";
      setSaveFeedback({ kind: "err", message });
    }
  }

  return (
    <>
      <ConfigSectionHeading
        title="Configuração da ingestão"
        description="Janela de avisos e quais modalidades e portais esta fonte deve ingerir. A frequência da coleta é definida no Agendamento da coleta, acima."
      />

      {running && (
        <div className="banner">
          <RefreshCw aria-hidden="true" />
          <div>
            <b>Coleta em andamento</b>
            <p>
              As alterações salvas agora valem na próxima execução, sem redeploy. A coleta atual não
              é afetada.
            </p>
          </div>
        </div>
      )}

      <form className="card form-card" onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="section-title" style={{ margin: "0 0 16px" }}>
          <h3>Janela de avisos</h3>
        </div>
        <div className={cn("field", errors.janelaDias && "invalid")} style={{ maxWidth: 300 }}>
          <label htmlFor="cfg-janela">Janela de dias dos avisos</label>
          <div className="input-affix">
            <input
              type="number"
              id="cfg-janela"
              min={MIN_JANELA}
              max={MAX_JANELA}
              aria-invalid={Boolean(errors.janelaDias)}
              {...register("janelaDias", { valueAsNumber: true })}
            />
            <span className="suffix">dias</span>
          </div>
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.janelaDias?.message ?? `Informe um valor entre ${MIN_JANELA} e ${MAX_JANELA} dias.`}
          </div>
          <div className="helper">
            Ingerir apenas avisos publicados/alterados dentro desta janela.
          </div>
        </div>

        <div className="section-title" style={{ margin: "24px 0 13px" }}>
          <h3>Modalidades a ingerir</h3>
        </div>
        <div className="helper" style={{ margin: "-6px 0 12px" }}>
          Marque as modalidades a coletar. Deixe em branco para ingerir todas.
        </div>
        <div className="chk-grid">
          {MODALIDADES.map((m) => {
            const on = modalidades.includes(m.value);
            return (
              <label key={m.value} className={cn("chk", on && "on")}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => toggle("modalidades", m.value, e.target.checked)}
                />
                <div className="t">{m.label}</div>
              </label>
            );
          })}
        </div>
        {errors.modalidades && (
          <div className="err-msg" style={{ display: "flex", marginTop: 9 }}>
            <TriangleAlert aria-hidden="true" />
            {errors.modalidades.message}
          </div>
        )}

        <div className="section-title" style={{ margin: "24px 0 13px" }}>
          <h3>Portais a ingerir</h3>
        </div>
        <div className="chk-grid">
          {PORTAIS.map((p) => {
            const on = portais.includes(p.value);
            return (
              <label key={p.value} className={cn("chk", on && "on")}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => toggle("portais", p.value, e.target.checked)}
                />
                <div className="t">{p.label}</div>
              </label>
            );
          })}
        </div>
        {errors.portais && (
          <div className="err-msg" style={{ display: "flex", marginTop: 9 }}>
            <TriangleAlert aria-hidden="true" />
            {errors.portais.message}
          </div>
        )}

        <div className="form-foot" style={{ marginTop: 26 }}>
          <button className="btn btn-primary" type="submit" disabled={salvar.isPending}>
            {salvar.isPending ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            <span>{salvar.isPending ? "Salvando…" : "Salvar configuração"}</span>
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              reset(toDefaults(initial));
              setSaveFeedback(null);
            }}
            disabled={!isDirty || salvar.isPending}
          >
            Descartar alterações
          </button>
          {saveFeedback && (
            <span className={cn("save-note", saveFeedback.kind === "err" && "err")}>
              {saveFeedback.kind === "err" ? (
                <TriangleAlert aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {saveFeedback.message}
            </span>
          )}
        </div>
      </form>
    </>
  );
}
