"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, SlidersHorizontal, TriangleAlert } from "lucide-react";
import {
  useAutomacaoConfig,
  useUpdateAutomacaoConfig,
} from "@/hooks/use-automacao-config";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { WidgetError } from "@/components/cockpit/widget-error";

// Valores iniciais do singleton (criterio de aceite).
const DEFAULTS = {
  diasCarencia: 30,
  limiarInferior: 0.35,
  limiarSuperior: 0.55,
  kFewShot: 8,
  descarteFisicoLigado: false,
  triarApenasFuturos: false,
  triagemHorizonteDias: 0,
};

const configSchema = z
  .object({
    diasCarencia: z
      .number({ invalid_type_error: "Informe um número." })
      .int("Use um número inteiro.")
      .min(1, "Mínimo de 1 dia.")
      .max(365, "Máximo de 365 dias."),
    limiarInferior: z
      .number({ invalid_type_error: "Informe um número." })
      .min(0, "Mínimo 0.")
      .max(1, "Máximo 1."),
    limiarSuperior: z
      .number({ invalid_type_error: "Informe um número." })
      .min(0, "Mínimo 0.")
      .max(1, "Máximo 1."),
    kFewShot: z
      .number({ invalid_type_error: "Informe um número." })
      .int("Use um número inteiro.")
      .min(0, "Mínimo 0.")
      .max(50, "Máximo 50."),
    descarteFisicoLigado: z.boolean(),
    triarApenasFuturos: z.boolean(),
    triagemHorizonteDias: z
      .number({ invalid_type_error: "Informe um número." })
      .int("Use um número inteiro.")
      .min(0, "Mínimo 0.")
      .max(3650, "Máximo 3650."),
  })
  .refine((v) => v.limiarInferior <= v.limiarSuperior, {
    path: ["limiarInferior"],
    message: "O limiar inferior deve ser ≤ ao limiar superior.",
  });
type ConfigValues = z.infer<typeof configSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * cmp-automacao-config-form — singleton da automacao: carencia da lixeira,
 * limiares de confianca (inferior/superior), K de few-shot e o interruptor de
 * descarte fisico. Validacao react-hook-form + zod ANTES do PUT (limiar
 * inferior <= superior; faixas travadas). Avisa que as mudancas valem na
 * proxima execucao da esteira. Hidrata do GET; estados loading/error tratados.
 */
export function AutomacaoConfigForm() {
  const { data, isLoading, isError, refetch } = useAutomacaoConfig();
  const salvar = useUpdateAutomacaoConfig();

  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ConfigValues>({
    resolver: zodResolver(configSchema),
    defaultValues: DEFAULTS,
  });

  // Hidrata o formulario quando a config chega (singleton).
  useEffect(() => {
    if (!data) return;
    reset({
      diasCarencia: data.diasCarencia,
      limiarInferior: data.limiarInferior,
      limiarSuperior: data.limiarSuperior,
      kFewShot: data.kFewShot,
      descarteFisicoLigado: data.descarteFisicoLigado,
      triarApenasFuturos: data.triarApenasFuturos,
      triagemHorizonteDias: data.triagemHorizonteDias,
    });
  }, [data, reset]);

  async function onSubmit(values: ConfigValues) {
    setFeedback(null);
    try {
      await salvar.mutateAsync({
        diasCarencia: values.diasCarencia,
        limiarInferior: values.limiarInferior,
        limiarSuperior: values.limiarSuperior,
        kFewShot: values.kFewShot,
        descarteFisicoLigado: values.descarteFisicoLigado,
        triarApenasFuturos: values.triarApenasFuturos,
        triagemHorizonteDias: values.triagemHorizonteDias,
      });
      setFeedback({ kind: "ok", message: "Configuração salva." });
    } catch (err) {
      const message =
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? "Dados inválidos: revise os campos."
          : "Não foi possível salvar a configuração. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  if (isLoading) {
    return (
      <div className="card form-card form-card--wide">
        <div className="helper" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 className="spin" aria-hidden="true" />
          <span>Carregando configuração…</span>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <WidgetError
        title="Não foi possível carregar"
        message="Não foi possível carregar a configuração. Tente novamente."
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <form className="card form-card form-card--wide" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="section-title">
        <h3>
          <SlidersHorizontal aria-hidden="true" />
          Configuração da esteira
        </h3>
      </div>
      <p className="helper" style={{ marginTop: 2, marginBottom: 14 }}>
        Parâmetros da triagem automática. As alterações valem na próxima execução
        da esteira.
      </p>

      <div className="grid-fields">
        <div className={cn("field", errors.diasCarencia && "invalid")}>
          <label htmlFor="cfg-carencia">Dias de carência</label>
          <input
            id="cfg-carencia"
            type="number"
            min={1}
            max={365}
            step={1}
            aria-invalid={Boolean(errors.diasCarencia)}
            {...register("diasCarencia", { valueAsNumber: true })}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.diasCarencia?.message ?? "Entre 1 e 365 dias."}
          </div>
          <div className="helper">
            Tempo na lixeira antes do descarte previsto. Entre 1 e 365.
          </div>
        </div>

        <div className={cn("field", errors.kFewShot && "invalid")}>
          <label htmlFor="cfg-k">K de few-shot</label>
          <input
            id="cfg-k"
            type="number"
            min={0}
            max={50}
            step={1}
            aria-invalid={Boolean(errors.kFewShot)}
            {...register("kFewShot", { valueAsNumber: true })}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.kFewShot?.message ?? "Entre 0 e 50."}
          </div>
          <div className="helper">Exemplos rotulados enviados ao subagente. Entre 0 e 50.</div>
        </div>

        <div className={cn("field", errors.triagemHorizonteDias && "invalid")}>
          <label htmlFor="cfg-horizonte">Horizonte de triagem (dias)</label>
          <input
            id="cfg-horizonte"
            type="number"
            min={0}
            max={3650}
            step={1}
            aria-invalid={Boolean(errors.triagemHorizonteDias)}
            {...register("triagemHorizonteDias", { valueAsNumber: true })}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.triagemHorizonteDias?.message ?? "Entre 0 e 3650."}
          </div>
          <div className="helper">
            Só triagem avisos que abrem dentro deste prazo. 0 = sem limite.
          </div>
        </div>

        <div className={cn("field", errors.limiarInferior && "invalid")}>
          <label htmlFor="cfg-limiar-inf">Limiar inferior</label>
          <input
            id="cfg-limiar-inf"
            type="number"
            min={0}
            max={1}
            step={0.05}
            aria-invalid={Boolean(errors.limiarInferior)}
            {...register("limiarInferior", { valueAsNumber: true })}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.limiarInferior?.message ?? "Entre 0 e 1."}
          </div>
          <div className="helper">Abaixo deste valor, o aviso é tratado como lixo.</div>
        </div>

        <div className={cn("field", errors.limiarSuperior && "invalid")}>
          <label htmlFor="cfg-limiar-sup">Limiar superior</label>
          <input
            id="cfg-limiar-sup"
            type="number"
            min={0}
            max={1}
            step={0.05}
            aria-invalid={Boolean(errors.limiarSuperior)}
            {...register("limiarSuperior", { valueAsNumber: true })}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.limiarSuperior?.message ?? "Entre 0 e 1."}
          </div>
          <div className="helper">Acima deste valor, o aviso é tratado como útil.</div>
        </div>
      </div>

      <label className="chk" style={{ marginTop: 14, maxWidth: 360 }}>
        <input type="checkbox" {...register("triarApenasFuturos")} />
        <div className="t">Triar apenas avisos futuros</div>
      </label>
      <p className="helper" style={{ marginTop: 6 }}>
        Ligado: ignora avisos cuja abertura dos lances já passou. Avisos sem data
        de abertura entram sempre.
      </p>

      <label className="chk" style={{ marginTop: 14, maxWidth: 360 }}>
        <input type="checkbox" {...register("descarteFisicoLigado")} />
        <div className="t">Descarte físico ligado</div>
      </label>
      <p className="helper" style={{ marginTop: 6 }}>
        Desligado (modo sombra): nada é apagado de fato. Ligado: a lixeira é
        esvaziada após a carência.
      </p>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={salvar.isPending}>
          {salvar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{salvar.isPending ? "Salvando…" : "Salvar configuração"}</span>
        </button>
        {feedback && (
          <span className={cn("save-note", feedback.kind === "err" && "err")}>
            {feedback.kind === "err" ? (
              <TriangleAlert aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {feedback.message}
          </span>
        )}
      </div>
    </form>
  );
}
