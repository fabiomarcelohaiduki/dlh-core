"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CalendarClock, Check, Loader2, TriangleAlert } from "lucide-react";
import { useSalvarAgendamentoFonte } from "@/hooks/use-admin";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { AgendamentoFonteState } from "@/lib/api/types";

/**
 * Frequencias recorrentes da coleta DESTA fonte. 'manual' (desligado) e
 * expresso pelo proprio toggle "ativo"; nao aparece como opcao de frequencia.
 */
const FREQUENCIAS = [
  { value: "horaria", label: "A cada hora" },
  { value: "diaria", label: "Uma vez ao dia" },
  { value: "semanal", label: "Uma vez por semana" },
  { value: "mensal", label: "Uma vez por mês" },
] as const;

/** Dias da semana (LOCAL); 0 = domingo. O substrato ajusta o fuso para UTC. */
const DIAS_SEMANA = [
  { value: 0, label: "Domingo" },
  { value: 1, label: "Segunda" },
  { value: 2, label: "Terça" },
  { value: 3, label: "Quarta" },
  { value: 4, label: "Quinta" },
  { value: 5, label: "Sexta" },
  { value: 6, label: "Sábado" },
] as const;

/**
 * Schema cliente (espelha agendamentoFonteConfigSchema do backend). horario em
 * 'HH:MM' local; diaSemana 0..6; diaMes 1..28. Mantidos sempre com valores
 * validos (defaults) e exibidos conforme a frequencia, evitando refinamentos.
 */
const agSchema = z.object({
  ativo: z.boolean(),
  frequencia: z.enum(["horaria", "diaria", "semanal", "mensal"]),
  horarioReferencia: z
    .string()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM (00:00 a 23:59)."),
  diaSemana: z.number().int().min(0).max(6),
  diaMes: z
    .number({ invalid_type_error: "Informe um dia entre 1 e 28." })
    .int("Use um dia inteiro.")
    .min(1, "Informe um dia entre 1 e 28.")
    .max(28, "Informe um dia entre 1 e 28."),
});
type AgValues = z.infer<typeof agSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

function toDefaults(initial: AgendamentoFonteState): AgValues {
  const freq = initial.frequencia === "manual" ? "diaria" : initial.frequencia;
  return {
    ativo: initial.ativo,
    frequencia: freq,
    horarioReferencia: initial.horarioReferencia ?? "07:00",
    diaSemana: initial.diaSemana ?? 1,
    diaMes: initial.diaMes ?? 1,
  };
}

/**
 * cmp-agendamento-fonte-form — Agendamento POR FONTE da coleta.
 *
 * Cada fonte tem seu proprio relogio (job pg_cron coleta-<tipo>); este form
 * mora dentro do card de configuracao da fonte. O toggle "ativo" liga/desliga
 * a coleta automatica DESTA fonte; frequencia + horario definem a cadencia.
 * Salvar reescreve o pg_cron no substrato (sem redeploy) via
 * PUT /agendamento-fonte-config.
 */
export function AgendamentoFonteForm({ initial }: { initial: AgendamentoFonteState }) {
  const salvar = useSalvarAgendamentoFonte();
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<AgValues>({
    resolver: zodResolver(agSchema),
    defaultValues: toDefaults(initial),
  });

  const ativo = watch("ativo");
  const frequencia = watch("frequencia");

  async function onSubmit(values: AgValues) {
    setFeedback(null);
    try {
      await salvar.mutateAsync({
        fonte: initial.fonte,
        // recurso presente => grava o agendamento POR MODULO; ausente =>
        // agendamento POR FONTE (Effecti/Gmail). Propaga o que veio do server.
        recurso: initial.recurso ?? undefined,
        ativo: values.ativo,
        frequencia: values.frequencia,
        horarioReferencia: values.horarioReferencia,
        diaSemana: values.frequencia === "semanal" ? values.diaSemana : null,
        diaMes: values.frequencia === "mensal" ? values.diaMes : null,
      });
      reset(values);
      setFeedback({
        kind: "ok",
        message: values.ativo
          ? "Agendamento salvo · coleta automática ligada"
          : "Agendamento salvo · coleta automática desligada",
      });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 400
          ? "Dados inválidos: revise a frequência e o horário."
          : "Não foi possível salvar o agendamento. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  return (
    <>
      <form className="card form-card" onSubmit={handleSubmit(onSubmit)} noValidate>
      <label
        className={cn("chk", ativo && "on")}
        style={{ margin: "0 0 18px", maxWidth: 360 }}
      >
        <input
          type="checkbox"
          checked={ativo}
          onChange={(e) => {
            setValue("ativo", e.target.checked, { shouldDirty: true });
            setFeedback(null);
          }}
        />
        <div className="t">
          Coleta automática ligada
        </div>
      </label>

      {ativo && (
        <>
      <div className="grid-fields">
        <div className="field">
          <label htmlFor="agf-freq">Frequência</label>
          <select id="agf-freq" {...register("frequencia")}>
            {FREQUENCIAS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <div className="helper">Com que frequência esta fonte dispara a coleta.</div>
        </div>

        <div className={cn("field", errors.horarioReferencia && "invalid")}>
          <label htmlFor="agf-hora">Horário</label>
          <input
            type="time"
            id="agf-hora"
            aria-invalid={Boolean(errors.horarioReferencia)}
            {...register("horarioReferencia")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.horarioReferencia?.message ?? "Use HH:MM (00:00 a 23:59)."}
          </div>
          <div className="helper">
            {frequencia === "horaria"
              ? "Na frequência horária, apenas os minutos são usados."
              : "Horário local (America/São_Paulo)."}
          </div>
        </div>
      </div>

      {frequencia === "semanal" && (
        <div className="field" style={{ maxWidth: 300 }}>
          <label htmlFor="agf-dow">Dia da semana</label>
          <select id="agf-dow" {...register("diaSemana", { valueAsNumber: true })}>
            {DIAS_SEMANA.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {frequencia === "mensal" && (
        <div className={cn("field", errors.diaMes && "invalid")} style={{ maxWidth: 300 }}>
          <label htmlFor="agf-dom">Dia do mês</label>
          <div className="input-affix">
            <input
              type="number"
              id="agf-dom"
              min={1}
              max={28}
              aria-invalid={Boolean(errors.diaMes)}
              {...register("diaMes", { valueAsNumber: true })}
            />
            <span className="suffix">dia</span>
          </div>
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.diaMes?.message ?? "Informe um dia entre 1 e 28."}
          </div>
          <div className="helper">De 1 a 28 (evita meses sem o dia 29/30/31).</div>
        </div>
      )}
        </>
      )}

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={salvar.isPending}>
          {salvar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <CalendarClock aria-hidden="true" />
          )}
          <span>{salvar.isPending ? "Salvando…" : "Salvar agendamento"}</span>
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            reset(toDefaults(initial));
            setFeedback(null);
          }}
          disabled={!isDirty || salvar.isPending}
        >
          Descartar alterações
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
    </>
  );
}
