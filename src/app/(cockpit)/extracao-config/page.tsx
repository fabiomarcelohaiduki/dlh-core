import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ExtracaoConfigForm } from "@/components/cockpit/extracao-config-form";
import { AgendamentoExtracaoForm } from "@/components/cockpit/agendamento-extracao-form";
import { AgendamentoOcrForm } from "@/components/cockpit/agendamento-ocr-form";
import { ExtracaoDisparoForm } from "@/components/cockpit/extracao-disparo-form";
import type {
  AgendamentoExtracaoState,
  ConfigExtracaoState,
  Frequencia,
  FonteExtracao,
} from "@/lib/api/types";

export const metadata: Metadata = { title: "Parâmetros de extração" };

const FONTES_EXTRACAO_VALIDAS: ReadonlySet<string> = new Set(["nomus", "effecti", "drive"]);
const FREQUENCIAS_VALIDAS: ReadonlySet<string> = new Set([
  "manual",
  "horaria",
  "diaria",
  "semanal",
  "mensal",
]);

/** Linha lida de public.config_extracao (singleton de parametros da camada 1). */
interface ConfigExtracaoRow {
  ocr_estrategia: string | null;
  ocr_idioma: string | null;
  tamanho_max_bytes: number | null;
  timeout_ms: number | null;
  extensoes_habilitadas: string[] | null;
  fontes_habilitadas: string[] | null;
  lote_tamanho: number | null;
  pausa_lote_ms: number | null;
}

/** Colunas de agendamento da extracao (mesmo singleton config_extracao). */
interface AgendamentoExtracaoRow {
  agendamento_ativo: boolean | null;
  frequencia: string | null;
  horario_referencia: string | null;
  dia_semana: number | null;
  dia_mes: number | null;
}

/** Colunas de agendamento do OCR (mesmo singleton, prefixo ocr_*). */
interface AgendamentoOcrRow {
  ocr_agendamento_ativo: boolean | null;
  ocr_frequencia: string | null;
  ocr_horario_referencia: string | null;
  ocr_dia_semana: number | null;
  ocr_dia_mes: number | null;
}

/**
 * Hidratacao server-side (RLS) dos parametros da camada 1 do extrator
 * (singleton config_extracao) para o cmp-extracao-config-form. Sem linha
 * (estado inicial improvavel — ha seed) cai nos defaults do produto.
 */
async function loadConfigExtracao(): Promise<ConfigExtracaoState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("config_extracao")
    .select(
      "ocr_estrategia, ocr_idioma, tamanho_max_bytes, timeout_ms, extensoes_habilitadas, fontes_habilitadas, lote_tamanho, pausa_lote_ms",
    )
    .limit(1)
    .maybeSingle();

  const data = (raw ?? null) as ConfigExtracaoRow | null;
  const estrategia = data?.ocr_estrategia;
  const fontes = data?.fontes_habilitadas;

  return {
    ocrEstrategia:
      estrategia === "nunca" || estrategia === "sempre" ? estrategia : "auto",
    ocrIdioma: data?.ocr_idioma ?? "por+eng",
    tamanhoMaxBytes: data?.tamanho_max_bytes ?? 104857600,
    timeoutMs: data?.timeout_ms ?? 120000,
    extensoesHabilitadas: data?.extensoes_habilitadas ?? null,
    fontesHabilitadas:
      Array.isArray(fontes) && fontes.length > 0
        ? (fontes.filter((f) => FONTES_EXTRACAO_VALIDAS.has(f)) as FonteExtracao[])
        : null,
    loteTamanho: data?.lote_tamanho ?? 10,
    pausaLoteMs: data?.pausa_lote_ms ?? 0,
  };
}

/**
 * Hidratacao server-side (RLS) do agendamento da extracao (mesmo singleton
 * config_extracao). Sem linha cai nos defaults do produto (desligado, diaria
 * 23:00). `frequencia` invalida -> 'manual' (desligado).
 */
async function loadAgendamentoExtracao(): Promise<AgendamentoExtracaoState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("config_extracao")
    .select("agendamento_ativo, frequencia, horario_referencia, dia_semana, dia_mes")
    .limit(1)
    .maybeSingle();

  const data = (raw ?? null) as AgendamentoExtracaoRow | null;
  const freq = data?.frequencia;

  return {
    ativo: data?.agendamento_ativo ?? false,
    frequencia:
      freq && FREQUENCIAS_VALIDAS.has(freq) ? (freq as Frequencia) : "manual",
    horarioReferencia: data?.horario_referencia ?? null,
    diaSemana: data?.dia_semana ?? null,
    diaMes: data?.dia_mes ?? null,
  };
}

/**
 * Hidratacao server-side (RLS) do agendamento do OCR (colunas ocr_* do mesmo
 * singleton config_extracao). Sem linha cai nos defaults do produto (desligado,
 * diaria 01:00). `frequencia` invalida -> 'manual' (desligado). Reusa
 * AgendamentoExtracaoState (forma identica).
 */
async function loadAgendamentoOcr(): Promise<AgendamentoExtracaoState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("config_extracao")
    .select(
      "ocr_agendamento_ativo, ocr_frequencia, ocr_horario_referencia, ocr_dia_semana, ocr_dia_mes",
    )
    .limit(1)
    .maybeSingle();

  const data = (raw ?? null) as AgendamentoOcrRow | null;
  const freq = data?.ocr_frequencia;

  return {
    ativo: data?.ocr_agendamento_ativo ?? false,
    frequencia:
      freq && FREQUENCIAS_VALIDAS.has(freq) ? (freq as Frequencia) : "manual",
    horarioReferencia: data?.ocr_horario_referencia ?? null,
    diaSemana: data?.ocr_dia_semana ?? null,
    diaMes: data?.ocr_dia_mes ?? null,
  };
}

export default async function ExtracaoConfigPage() {
  const [configExtracao, agendamentoExtracao, agendamentoOcr] = await Promise.all([
    loadConfigExtracao(),
    loadAgendamentoExtracao(),
    loadAgendamentoOcr(),
  ]);

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Parâmetros de extração</h2>
          <p>Configuração da camada 1 do extrator de anexos (texto puro, sem LLM).</p>
        </div>
      </div>

      <div className="extracao-acoes-row">
        <AgendamentoExtracaoForm initial={agendamentoExtracao} />
        <AgendamentoOcrForm initial={agendamentoOcr} />
        <ExtracaoDisparoForm />
      </div>

      <ExtracaoConfigForm initial={configExtracao} />
    </section>
  );
}
