import { createClient } from "@/lib/supabase/server";
import type {
  AgendamentoExtracaoState,
  ConfigExtracaoState,
  ConfigIndexacaoState,
  Frequencia,
  FonteExtracao,
  FonteIndexacao,
} from "@/lib/api/types";

// =====================================================================
// Hidratacao server-side (RLS) dos parametros da Extracao (camada 1). Lido
// tanto pela tela de Extracao quanto pela guia "Fila de extração" da Coleta
// (Parâmetros). Singleton config_extracao + presenca da credencial Nomus.
// O segredo do Nomus jamais trafega ao cliente: deriva-se so `configurado`.
// =====================================================================

const FONTES_EXTRACAO_VALIDAS: ReadonlySet<string> = new Set(["nomus", "effecti", "drive"]);
const FONTES_INDEXACAO_VALIDAS: ReadonlySet<string> = new Set([
  "nomus",
  "effecti",
  "drive",
  "gmail",
]);
const FREQUENCIAS_VALIDAS: ReadonlySet<string> = new Set([
  "manual",
  "horaria",
  "diaria",
  "semanal",
  "mensal",
]);

/** Linha lida de public.fontes (apenas a presenca da referencia, nunca o segredo). */
interface FonteRow {
  token_cifrado: string | null;
}

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

/** Linha lida de public.config_indexacao (singleton da camada de embeddings). */
interface ConfigIndexacaoRow {
  ativo: boolean | null;
  processos_ativo: boolean | null;
  fontes_habilitadas: string[] | null;
  lote_chunks: number | null;
  pausa_ms: number | null;
  tpm_alvo: number | null;
  tentativas_max: number | null;
  embeddings_provider: string | null;
  embeddings_endpoint: string | null;
}

/** Colunas de agendamento da extracao (mesmo singleton config_extracao). */
interface AgendamentoExtracaoRow {
  agendamento_ativo: boolean | null;
  frequencia: string | null;
  horario_referencia: string | null;
  dia_semana: number | null;
  dia_mes: number | null;
}

/**
 * Estado da credencial Nomus: deriva apenas `configurado` (token_cifrado !=
 * null) para bloquear/liberar a descoberta; o segredo nunca vai ao cliente.
 */
export async function loadNomusConfigurado(): Promise<boolean> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("fontes")
    .select("token_cifrado")
    .eq("tipo", "nomus")
    .maybeSingle();
  const data = (raw ?? null) as FonteRow | null;
  return Boolean(data?.token_cifrado);
}

/**
 * Parametros da camada 1 do extrator (singleton config_extracao) para o
 * cmp-extracao-config-form. Sem linha cai nos defaults do produto.
 */
export async function loadConfigExtracao(): Promise<ConfigExtracaoState> {
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
 * Agendamento da extracao (mesmo singleton config_extracao). Sem linha cai nos
 * defaults do produto (desligado, diaria 23:00). `frequencia` invalida ->
 * 'manual' (desligado).
 */
export async function loadAgendamentoExtracao(): Promise<AgendamentoExtracaoState> {
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
 * Config da indexacao (singleton config_indexacao) para o cmp-indexacao-config-form
 * (Parâmetros da guia Indexação) e os interruptores do agendamento. Sem linha
 * (improvavel — ha seed) cai nos defaults do produto (desligado, todas as
 * fontes, 1500/0). `embeddings_provider` invalido -> 'openai'.
 */
export async function loadConfigIndexacao(): Promise<ConfigIndexacaoState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("config_indexacao")
    .select(
      "ativo, processos_ativo, fontes_habilitadas, lote_chunks, pausa_ms, tpm_alvo, tentativas_max, embeddings_provider, embeddings_endpoint",
    )
    .limit(1)
    .maybeSingle();

  const data = (raw ?? null) as ConfigIndexacaoRow | null;
  const fontes = data?.fontes_habilitadas;

  return {
    ativo: data?.ativo ?? false,
    processosAtivo: data?.processos_ativo ?? false,
    fontesHabilitadas:
      Array.isArray(fontes) && fontes.length > 0
        ? (fontes.filter((f) => FONTES_INDEXACAO_VALIDAS.has(f)) as FonteIndexacao[])
        : null,
    loteChunks: data?.lote_chunks ?? 1500,
    pausaMs: data?.pausa_ms ?? 0,
    tpmAlvo: data?.tpm_alvo ?? 800000,
    tentativasMax: data?.tentativas_max ?? 3,
    embeddingsProvider: data?.embeddings_provider === "bge-m3-local" ? "bge-m3-local" : "openai",
    embeddingsEndpoint:
      typeof data?.embeddings_endpoint === "string" && data.embeddings_endpoint.trim() !== ""
        ? data.embeddings_endpoint.trim()
        : null,
  };
}

/**
 * Agendamento da DESCOBERTA (enfileiramento) do Nomus (tabela config_descoberta,
 * 1 linha por fonte). Materializa a fila de extracao server-side na hora marcada.
 * Sem linha cai nos defaults do produto (desligado, manual). So o Nomus tem
 * relogio proprio: Effecti auto-descobre pos-coleta e Gmail/Drive entregam a
 * lista na coleta. `frequencia` invalida -> 'manual' (desligado).
 */
export async function loadAgendamentoDescobertaNomus(): Promise<AgendamentoExtracaoState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("config_descoberta")
    .select("agendamento_ativo, frequencia, horario_referencia, dia_semana, dia_mes")
    .eq("fonte", "nomus")
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
