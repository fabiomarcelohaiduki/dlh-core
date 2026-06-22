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
  processosAtivo: z.boolean(),
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
  tpmAlvo: z
    .number({ invalid_type_error: "Informe o teto de tokens/min." })
    .int("Use um valor inteiro.")
    .min(0, "Não pode ser negativo.")
    .max(10000000, "Máximo 10000000."),
  tentativasMax: z
    .number({ invalid_type_error: "Informe o máximo de tentativas." })
    .int("Use um valor inteiro.")
    .min(1, "Mínimo 1.")
    .max(10, "Máximo 10."),
  embeddingsProvider: z.enum(["openai", "bge-m3-local"]),
  embeddingsEndpoint: z.string().trim().nullable().optional(),
})
  // bge-m3-local exige endpoint válido; openai ignora (o endpoint vira null).
  .superRefine((val, ctx) => {
    if (val.embeddingsProvider !== "bge-m3-local") return;
    const ep = val.embeddingsEndpoint?.trim();
    if (!ep) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embeddingsEndpoint"],
        message: "Informe o endpoint do serviço bge-m3.",
      });
    } else if (!/^https?:\/\/.+/.test(ep)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embeddingsEndpoint"],
        message: "URL inválida (ex.: http://192.168.1.6:8080).",
      });
    }
  });
type CfgValues = z.infer<typeof cfgSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

function toDefaults(initial: ConfigIndexacaoState): CfgValues {
  return {
    ativo: initial.ativo,
    processosAtivo: initial.processosAtivo,
    // null = todas: marca todas as fontes conhecidas.
    fontes: initial.fontesHabilitadas ?? FONTES.map((f) => f.value),
    loteChunks: initial.loteChunks,
    pausaMs: initial.pausaMs,
    tpmAlvo: initial.tpmAlvo,
    tentativasMax: initial.tentativasMax,
    embeddingsProvider: initial.embeddingsProvider,
    embeddingsEndpoint: initial.embeddingsEndpoint ?? "",
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
  const processosAtivo = watch("processosAtivo");
  const fontesSel = watch("fontes");
  const embeddingsProvider = watch("embeddingsProvider");
  // Trocar o provider muda o espaco vetorial: alerta de recall (reindex).
  const providerTrocado = embeddingsProvider !== initial.embeddingsProvider;

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
        processosAtivo: values.processosAtivo,
        fontesHabilitadas: parseFontes(values.fontes),
        loteChunks: values.loteChunks,
        pausaMs: values.pausaMs,
        tpmAlvo: values.tpmAlvo,
        tentativasMax: values.tentativasMax,
        embeddingsProvider: values.embeddingsProvider,
        // openai ignora endpoint; bge-m3-local manda a URL (ja validada).
        embeddingsEndpoint:
          values.embeddingsProvider === "bge-m3-local"
            ? values.embeddingsEndpoint?.trim() || null
            : null,
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
        <label>Motor de embeddings</label>
        <div className="filter-group segmented" role="group" aria-label="Motor de embeddings">
          <button
            type="button"
            className={cn("btn", "btn-sm", embeddingsProvider === "openai" && "btn-primary")}
            aria-pressed={embeddingsProvider === "openai"}
            onClick={() =>
              setValue("embeddingsProvider", "openai", { shouldDirty: true, shouldValidate: true })
            }
          >
            OpenAI · custo
          </button>
          <button
            type="button"
            className={cn("btn", "btn-sm", embeddingsProvider === "bge-m3-local" && "btn-primary")}
            aria-pressed={embeddingsProvider === "bge-m3-local"}
            onClick={() =>
              setValue("embeddingsProvider", "bge-m3-local", {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
          >
            bge-m3 local · grátis
          </button>
        </div>
        <div className="helper">
          OpenAI (text-embedding-3-small): qualidade gerenciada, custo por token, chave no Vault.
          bge-m3 local: self-hosted, sem custo, exige um endpoint acessível.
        </div>
      </div>

      {embeddingsProvider === "bge-m3-local" && (
        <div className={cn("field", errors.embeddingsEndpoint && "invalid")}>
          <label htmlFor="ix-endpoint">Endpoint do serviço bge-m3</label>
          <input
            type="text"
            id="ix-endpoint"
            placeholder="http://192.168.1.6:8080"
            aria-invalid={Boolean(errors.embeddingsEndpoint)}
            {...register("embeddingsEndpoint")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.embeddingsEndpoint?.message ?? "Informe a URL do serviço de embeddings."}
          </div>
          <div className="helper">
            URL HTTP do serviço self-hosted que gera os embeddings (contrato compatível com bge-m3).
          </div>
        </div>
      )}

      {providerTrocado && (
        <div className="banner">
          <TriangleAlert aria-hidden="true" />
          <div>
            <b>Trocar o motor exige reindexar todo o acervo</b>
            <p>
              Cada motor gera embeddings num espaço vetorial diferente. Ao salvar a troca, os chunks
              já gravados (avisos, documentos, processos) ficam incompatíveis com a busca semântica
              até serem reindexados. Rode o reprocessamento / &ldquo;Indexar agora&rdquo; após
              salvar.
            </p>
          </div>
        </div>
      )}

      <div className="field">
        <label>Interruptor da indexação · documentos</label>
        <label className={cn("chk", ativo && "on")} style={{ maxWidth: 340 }}>
          <input type="checkbox" checked={ativo} {...register("ativo")} />
          <div className="t">{ativo ? "Ligada (gerando embeddings)" : "Desligada (sem custo)"}</div>
        </label>
        <div className="helper">
          Master switch dos DOCUMENTOS (anexos extraídos das fontes): governa o contínuo e o
          backfill. Recomendado desligado até decidir gastar na OpenAI.
        </div>
      </div>

      <div className="field">
        <label>Interruptor da indexação · processos</label>
        <label className={cn("chk", processosAtivo && "on")} style={{ maxWidth: 340 }}>
          <input type="checkbox" checked={processosAtivo} {...register("processosAtivo")} />
          <div className="t">
            {processosAtivo ? "Ligada (gerando embeddings)" : "Desligada (sem custo)"}
          </div>
        </label>
        <div className="helper">
          Master switch dos PROCESSOS do Nomus (indexa a descrição). Independente do interruptor de
          documentos; compartilha o mesmo orçamento/pausa/ritmo abaixo. Recomendado desligado até
          decidir gastar na OpenAI.
        </div>
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
          (inclui fontes novas no futuro). Recomendado: todas marcadas.
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
            Edge; o restante segue no próximo lote auto-encadeado. Recomendado 1000.
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
          <div className="helper">
            Pausa entre documentos no backfill, para aliviar a OpenAI. Com o teto de tokens/min
            ligado, o ritmo já vem dele. Recomendado 0 (sem pausa).
          </div>
        </div>

        <div className={cn("field", errors.tpmAlvo && "invalid")}>
          <label htmlFor="ix-tpm">Teto de tokens por minuto</label>
          <div className="input-affix">
            <input
              type="number"
              id="ix-tpm"
              min={0}
              max={10000000}
              aria-invalid={Boolean(errors.tpmAlvo)}
              {...register("tpmAlvo", { valueAsNumber: true })}
            />
            <span className="suffix">tok/min</span>
          </div>
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.tpmAlvo?.message ?? "Entre 0 e 10000000."}
          </div>
          <div className="helper">
            Ritma os envios à OpenAI para não estourar o limite do plano (tier 1 = 1.000.000).
            Recomendado 800000 (80%). 0 = sem ritmo.
          </div>
        </div>

        <div className={cn("field", errors.tentativasMax && "invalid")}>
          <label htmlFor="ix-tentativas">Máximo de tentativas</label>
          <div className="input-affix">
            <input
              type="number"
              id="ix-tentativas"
              min={1}
              max={10}
              aria-invalid={Boolean(errors.tentativasMax)}
              {...register("tentativasMax", { valueAsNumber: true })}
            />
            <span className="suffix">tentativas</span>
          </div>
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.tentativasMax?.message ?? "Entre 1 e 10."}
          </div>
          <div className="helper">
            Quantas vezes o backfill re-tenta um documento (erro transitório) antes de marcá-lo como
            erro definitivo. Recomendado 3.
          </div>
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
