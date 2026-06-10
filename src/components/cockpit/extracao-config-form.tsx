"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, FileCog, Info, Loader2, TriangleAlert } from "lucide-react";
import { useSalvarConfigExtracao } from "@/hooks/use-documentos";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { ConfigExtracaoState, FonteExtracao } from "@/lib/api/types";

/** Estrategias de OCR expostas no painel (mapeiam no Tika no runner). */
const OCR_ESTRATEGIAS = [
  { value: "auto", label: "Automático (OCR só quando o texto nativo falha)" },
  { value: "nunca", label: "Nunca (apenas texto nativo, ignora escaneados)" },
  { value: "sempre", label: "Sempre (força OCR em todo documento)" },
] as const;

/** Fontes que o extrator sabe processar (adaptadores do runner). */
const FONTES: ReadonlyArray<{ value: FonteExtracao; label: string }> = [
  { value: "nomus", label: "Nomus (ERP)" },
  { value: "effecti", label: "Effecti (portal de licitações)" },
  { value: "drive", label: "Google Drive" },
  { value: "gmail", label: "Gmail" },
];

const BYTES_POR_MIB = 1024 * 1024;

/**
 * Schema cliente (espelha extracaoConfigSchema do backend, mas em UNIDADES de
 * exibicao: MiB e segundos). A conversao para bytes/ms acontece no onSubmit.
 * `extensoes` e um texto livre separado por virgula; vazio = todas.
 */
const cfgSchema = z.object({
  ocrEstrategia: z.enum(["auto", "nunca", "sempre"]),
  ocrIdioma: z
    .string()
    .trim()
    .min(1, "Informe ao menos um idioma (ex.: por+eng).")
    .regex(/^[a-z+]+$/i, "Use códigos Tesseract: letras e +, sem espaços."),
  tamanhoMaxMib: z
    .number({ invalid_type_error: "Informe o tamanho em MiB." })
    .int("Use um valor inteiro.")
    .min(1, "Mínimo 1 MiB.")
    .max(1024, "Máximo 1024 MiB (1 GiB)."),
  timeoutSegundos: z
    .number({ invalid_type_error: "Informe o timeout em segundos." })
    .int("Use um valor inteiro.")
    .min(1, "Mínimo 1 segundo.")
    .max(1800, "Máximo 1800 s (30 min)."),
  extensoes: z.string(),
  fontes: z
    .array(z.enum(["nomus", "effecti", "drive", "gmail"]))
    .min(1, "Selecione ao menos uma fonte para extrair."),
  loteTamanho: z
    .number({ invalid_type_error: "Informe quantos arquivos por lote." })
    .int("Use um valor inteiro.")
    .min(1, "Mínimo 1.")
    .max(1000, "Máximo 1000."),
  pausaLoteMs: z
    .number({ invalid_type_error: "Informe a pausa em milissegundos." })
    .int("Use um valor inteiro.")
    .min(0, "Não pode ser negativo.")
    .max(600000, "Máximo 600000 ms (10 min)."),
});
type CfgValues = z.infer<typeof cfgSchema>;

type Feedback = { kind: "ok" | "err"; message: string };

function toDefaults(initial: ConfigExtracaoState): CfgValues {
  return {
    ocrEstrategia: initial.ocrEstrategia,
    ocrIdioma: initial.ocrIdioma,
    tamanhoMaxMib: Math.max(1, Math.round(initial.tamanhoMaxBytes / BYTES_POR_MIB)),
    timeoutSegundos: Math.max(1, Math.round(initial.timeoutMs / 1000)),
    extensoes: (initial.extensoesHabilitadas ?? []).join(", "),
    // null = todas: marca todas as fontes conhecidas.
    fontes: initial.fontesHabilitadas ?? FONTES.map((f) => f.value),
    loteTamanho: initial.loteTamanho,
    pausaLoteMs: initial.pausaLoteMs,
  };
}

/** Selecao -> allowlist. Todas marcadas = null (= todas, futuro-prova). */
function parseFontes(sel: FonteExtracao[]): FonteExtracao[] | null {
  const dedup = Array.from(new Set(sel));
  return dedup.length >= FONTES.length ? null : dedup;
}

/** Texto livre -> allowlist normalizada (sem ponto, minúsculas, dedup). Vazio = null. */
function parseExtensoes(raw: string): string[] | null {
  const itens = raw
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
    .filter((e) => e.length > 0);
  return itens.length > 0 ? Array.from(new Set(itens)) : null;
}

/**
 * cmp-extracao-config-form — Parametros da camada 1 do extrator.
 *
 * Singleton GLOBAL (config_extracao) que o runner Node lê no início do job:
 * estratégia/idioma de OCR, teto de tamanho, timeout por arquivo, allowlist
 * de extensões e o ritmo de lote (alivia o Tika). Salvar vale na PRÓXIMA
 * execução (sem redeploy); não afeta um job em andamento.
 */
export function ExtracaoConfigForm({ initial }: { initial: ConfigExtracaoState }) {
  const salvar = useSalvarConfigExtracao();
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

  const fontesSel = watch("fontes");
  const ocrDesligado = watch("ocrEstrategia") === "nunca";

  function toggleFonte(value: FonteExtracao, checked: boolean) {
    const next = checked
      ? Array.from(new Set([...fontesSel, value]))
      : fontesSel.filter((v) => v !== value);
    setValue("fontes", next, { shouldDirty: true, shouldValidate: true });
  }

  async function onSubmit(values: CfgValues) {
    setFeedback(null);
    try {
      await salvar.mutateAsync({
        ocrEstrategia: values.ocrEstrategia,
        ocrIdioma: values.ocrIdioma,
        tamanhoMaxBytes: values.tamanhoMaxMib * BYTES_POR_MIB,
        timeoutMs: values.timeoutSegundos * 1000,
        extensoesHabilitadas: parseExtensoes(values.extensoes),
        fontesHabilitadas: parseFontes(values.fontes),
        loteTamanho: values.loteTamanho,
        pausaLoteMs: values.pausaLoteMs,
      });
      reset(values);
      setFeedback({ kind: "ok", message: "Configuração salva · vale na próxima extração." });
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
        <Info aria-hidden="true" />
        <div>
          <b>OCR é caro</b>
          <p>
            Documentos nativos (PDF/Office com texto) são lidos sem OCR. O OCR só entra em
            escaneados; PDFs grandes escaneados podem estourar o timeout e ficar como erro
            (acompanhe na tela de Extração).
          </p>
        </div>
      </div>

      <div className="grid-fields" style={{ marginTop: 14 }}>
        <div className="field">
          <label htmlFor="ex-ocr">Estratégia de OCR</label>
          <select id="ex-ocr" {...register("ocrEstrategia")}>
            {OCR_ESTRATEGIAS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="helper">Como decidir entre texto nativo e reconhecimento de imagem.</div>
        </div>

        <div className={cn("field", errors.ocrIdioma && "invalid")}>
          <label htmlFor="ex-idioma">Idiomas do OCR</label>
          <input
            type="text"
            id="ex-idioma"
            placeholder="por+eng"
            aria-invalid={Boolean(errors.ocrIdioma)}
            disabled={ocrDesligado}
            {...register("ocrIdioma")}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.ocrIdioma?.message ?? "Use códigos Tesseract (ex.: por+eng)."}
          </div>
          <div className="helper">
            {ocrDesligado
              ? "OCR desligado (Estratégia = Nunca): o idioma não é usado."
              : "Códigos Tesseract separados por +. Português + inglês cobre editais."}
          </div>
        </div>
      </div>

      <div className="grid-fields">
        <div className={cn("field", errors.tamanhoMaxMib && "invalid")}>
          <label htmlFor="ex-tam">Tamanho máximo por arquivo</label>
          <div className="input-affix">
            <input
              type="number"
              id="ex-tam"
              min={1}
              max={1024}
              aria-invalid={Boolean(errors.tamanhoMaxMib)}
              {...register("tamanhoMaxMib", { valueAsNumber: true })}
            />
            <span className="suffix">MiB</span>
          </div>
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.tamanhoMaxMib?.message ?? "Entre 1 e 1024 MiB."}
          </div>
          <div className="helper">Acima disso o anexo é pulado (vira erro com motivo).</div>
        </div>

        <div className={cn("field", errors.timeoutSegundos && "invalid")}>
          <label htmlFor="ex-timeout">Timeout por arquivo</label>
          <div className="input-affix">
            <input
              type="number"
              id="ex-timeout"
              min={1}
              max={1800}
              aria-invalid={Boolean(errors.timeoutSegundos)}
              {...register("timeoutSegundos", { valueAsNumber: true })}
            />
            <span className="suffix">s</span>
          </div>
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.timeoutSegundos?.message ?? "Entre 1 e 1800 s."}
          </div>
          <div className="helper">Tempo máximo no Tika por arquivo. Escaneados grandes pedem mais.</div>
        </div>
      </div>

      <div className={cn("field", errors.extensoes && "invalid")}>
        <label htmlFor="ex-ext">Extensões habilitadas</label>
        <input
          type="text"
          id="ex-ext"
          placeholder="pdf, docx, xlsx, png — vazio = todas"
          aria-invalid={Boolean(errors.extensoes)}
          {...register("extensoes")}
        />
        <div className="helper">
          Allowlist separada por vírgula (sem ponto). Deixe vazio para extrair todas as extensões.
        </div>
      </div>

      <div className={cn("field", errors.fontes && "invalid")}>
        <label>Fontes a extrair</label>
        <div className="chk-grid" role="group" aria-label="Fontes a extrair">
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
          Só os anexos das fontes marcadas entram na fila de extração. Todas marcadas = todas as
          fontes (inclui fontes novas no futuro).
        </div>
      </div>

      <div className="grid-fields">
        <div className={cn("field", errors.loteTamanho && "invalid")}>
          <label htmlFor="ex-lote">Arquivos por lote</label>
          <input
            type="number"
            id="ex-lote"
            min={1}
            max={1000}
            aria-invalid={Boolean(errors.loteTamanho)}
            {...register("loteTamanho", { valueAsNumber: true })}
          />
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.loteTamanho?.message ?? "Entre 1 e 1000."}
          </div>
          <div className="helper">Quantos anexos processar antes de pausar.</div>
        </div>

        <div className={cn("field", errors.pausaLoteMs && "invalid")}>
          <label htmlFor="ex-pausa">Pausa entre lotes</label>
          <div className="input-affix">
            <input
              type="number"
              id="ex-pausa"
              min={0}
              max={600000}
              aria-invalid={Boolean(errors.pausaLoteMs)}
              {...register("pausaLoteMs", { valueAsNumber: true })}
            />
            <span className="suffix">ms</span>
          </div>
          <div className="err-msg">
            <TriangleAlert aria-hidden="true" />
            {errors.pausaLoteMs?.message ?? "Entre 0 e 600000 ms."}
          </div>
          <div className="helper">Alivia o serviço Tika. 0 = sem pausa.</div>
        </div>
      </div>

      <div className="form-foot" style={{ marginTop: 22 }}>
        <button className="btn btn-primary" type="submit" disabled={salvar.isPending}>
          {salvar.isPending ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <FileCog aria-hidden="true" />
          )}
          <span>{salvar.isPending ? "Salvando…" : "Salvar parâmetros"}</span>
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
