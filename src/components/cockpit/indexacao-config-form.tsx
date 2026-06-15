"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { useSalvarConfigIndexacao } from "@/hooks/use-indexacao";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ConfigIndexacaoState, FonteIndexacao } from "@/lib/api/types";

/** Fontes cujos documentos podem ser indexados (mesmo universo da extracao). */
const FONTES: ReadonlyArray<{ value: FonteIndexacao; label: string }> = [
  { value: "nomus", label: "Nomus processos" },
  { value: "effecti", label: "Effecti" },
  { value: "drive", label: "Google Drive" },
  { value: "gmail", label: "Gmail" },
];

/** Espelha indexacaoConfigSchema do backend. */
const cfgSchema = z.object({
  ativo: z.boolean(),
  fontes: z
    .array(z.enum(["nomus", "effecti", "drive", "gmail"]))
    .min(1, "Selecione ao menos uma fonte para indexar."),
  loteChunks: z
    .number({ invalid_type_error: "Informe o orçamento de chunks." })
    .int("Use um valor inteiro.")
    .min(1, "Mínimo 1.")
    .max(10000, "Máximo 10000."),
  pausaMs: z
    .number({ invalid_type_error: "Informe a pausa em milissegundos." })
    .int("Use um valor inteiro.")
    .min(0, "Não pode ser negativo.")
    .max(600000, "Máximo 600000 ms (10 min)."),
});
type CfgValues = z.infer<typeof cfgSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

function toDefaults(initial: ConfigIndexacaoState): CfgValues {
  return {
    ativo: initial.ativo,
    // null = todas: marca todas as fontes conhecidas.
    fontes: initial.fontesHabilitadas ?? FONTES.map((f) => f.value),
    loteChunks: initial.loteChunks,
    pausaMs: initial.pausaMs,
  };
}

/** Selecao -> allowlist. Todas marcadas = null (= todas, futuro-prova). */
function parseFontes(sel: FonteIndexacao[]): FonteIndexacao[] | null {
  const dedup = Array.from(new Set(sel));
  return dedup.length >= FONTES.length ? null : dedup;
}

/**
 * cmp-indexacao-config-form — Config da camada de embeddings (config_indexacao).
 *
 * Singleton GLOBAL que governa o CONTINUO (push do runner) e o BACKFILL: master
 * switch `ativo` (gasta na OpenAI quando ON), allowlist de fontes, orcamento de
 * chunks por invocacao do backfill e pausa entre documentos. Salvar vale na
 * PROXIMA invocacao; nao afeta um lote em andamento.
 */
export function IndexacaoConfigForm({ initial }: { initial: ConfigIndexacaoState }) {
  const salvar = useSalvarConfigIndexacao();
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<CfgValues>({
    resolver: zodResolver(cfgSchema),
    defaultValues: toDefaults(initial),
  });

  const ativo = watch("ativo");
  const fontesSel = watch("fontes");

  function toggleFonte(value: FonteIndexacao, checked: boolean) {
    const next = checked
      ? Array.from(new Set([...fontesSel, value]))
      : fontesSel.filter((v) => v !== value);
    setValue("fontes", next, { shouldDirty: true, shouldValidate: true });
  }

  async function onSubmit(values: CfgValues) {
    setFeedback(null);
    try {
      await salvar.mutateAsync({
        ativo: values.ativo,
        fontesHabilitadas: parseFontes(values.fontes),
        loteChunks: values.loteChunks,
        pausaMs: values.pausaMs,
      });
      reset(values);
      setFeedback({ kind: "ok", message: "Configuração salva · vale na próxima indexação." });
    } catch (err) {
      const message =
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? "Dados inválidos: revise os campos destacados."
          : "Não foi possível salvar a configuração. Tente novamente.";
      setFeedback({ kind: "err", message });
    }
  }

  return (
    <form className="card form-card form-card--wide" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="banner">
        <TriangleAlert aria-hidden="true" />
        <div>
          <b>Indexar gera embeddings na OpenAI (custo por token)</b>
          <p>
            Com o interruptor LIGADO, todo documento novo é indexado no momento do push (contínuo) e
            o botão &ldquo;Indexar agora&rdquo; processa o acervo parado. Desligado, nada é indexado
            (os textos ficam pendentes). Mantenha desligado até decidir gastar.
          </p>
        </div>
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <label>Interruptor da indexação</label>
        <label className={cn("chk", ativo && "on")} style={{ maxWidth: 340 }}>
          <input type="checkbox" checked={ativo} {...register("ativo")} />
          <div className="t">{ativo ? "Ligada (gerando embeddings)" : "Desligada (sem custo)"}</div>
        </label>
        <div className="helper">Master switch global: governa o contínuo e o backfill.</div>
      </div>

      <div className={cn("field", errors.fontes && "invalid")}>
        <label>Fontes a indexar</label>
        <div className="chk-grid" role="group" aria-label="Fontes a indexar">
          {FONTES.map((f) => {
            const on = fontesSel.includes(f.value);
            return (
              <label key={f.value} className={cn("chk", on && "on")}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => toggleFonte(f.value, e.target.checked)}
                />
                <div className="t">{f.label}</div>
              </label>
            );
          })}
        </div>
        <div className="err-msg">
          <TriangleAlert aria-hidden="true" />
          {errors.fontes?.message ?? "Selecione ao menos uma fonte."}
        </div>
        <div className="helper">
          Só os documentos das fontes marcadas são indexados. Todas marcadas = todas as fontes
          (inclui fontes novas no futuro).
        </div>
      </div>

      <div className="grid-fields">
        <div className={cn("field", errors.loteChunks && "invalid")}>
          <label htmlFor="ix-lote">Orçamento por lote</label>
          <div className="input-affix">
            <input
              type="number"
              id="ix-lote"
              min={1}
              max={10000}
              aria-invalid={Boolean(errors.loteChunks)}
              {...register("loteChunks", { valueAsNumber: true })}
            />
            <span className="suffix">chunks</span>
          </div>
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.loteChunks?.message ?? "Entre 1 e 10000."}
          </div>
          <div className="helper">
            Teto de chunks por invocação do backfill (~2000 caracteres/chunk). Limita o wall-clock do
            Edge; o restante segue no próximo lote auto-encadeado.
          </div>
        </div>

        <div className={cn("field", errors.pausaMs && "invalid")}>
          <label htmlFor="ix-pausa">Pausa entre documentos</label>
          <div className="input-affix">
            <input
              type="number"
              id="ix-pausa"
              min={0}
              max={600000}
              aria-invalid={Boolean(errors.pausaMs)}
              {...register("pausaMs", { valueAsNumber: true })}
            />
            <span className="suffix">ms</span>
          </div>
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.pausaMs?.message ?? "Entre 0 e 600000 ms."}
          </div>
          <div className="helper">Alivia a OpenAI. 0 = sem pausa.</div>
        </div>
      </div>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={salvar.isPending}>
          {salvar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Sparkles aria-hidden="true" />
          )}
          <span>{salvar.isPending ? "Salvando…" : "Salvar configuração"}</span>
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
  );
}
