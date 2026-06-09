// =====================================================================
// _shared/validation.ts
// Validacao de input na borda com zod (server-side). Regras alinhadas a
// secao 4.5.1 da SPEC (validacao zod cliente + servidor). Erros de
// validacao viram HttpError 400 com mensagem util, sem vazar internals.
// =====================================================================

import { z, type ZodError, type ZodTypeAny } from "zod";
import { HttpError } from "./http.ts";

/** Janela de ingestao: minimo 1 dia, maximo definido pelo produto (US-03). */
export const MIN_JANELA_DIAS = 1;
export const MAX_JANELA_DIAS = 365;

/** Frequencias suportadas pelo agendamento (pg_cron governado por config). */
export const FREQUENCIAS = ["manual", "horaria", "diaria", "semanal", "mensal"] as const;
export type Frequencia = (typeof FREQUENCIAS)[number];

/** Opcoes de parsing/validacao do corpo. */
export interface ParseJsonBodyOptions {
  /**
   * Status HTTP para falha de schema (default 400). Endpoints parametrizados
   * por fonte usam 422 (SEC-03): valor fora da allowlist -> 422 sem I/O.
   */
  validationStatus?: number;
}

/**
 * Le o corpo JSON e valida com o schema fornecido. Lanca:
 *   - 400 invalid_body  -> JSON malformado.
 *   - 400/422 validation_error -> falha de schema (status via options).
 */
export async function parseJsonBody<S extends ZodTypeAny>(
  req: Request,
  schema: S,
  options: ParseJsonBodyOptions = {},
): Promise<z.infer<S>> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    throw new HttpError(400, "invalid_body", "nao foi possivel ler o corpo da requisicao");
  }

  let parsed: unknown;
  try {
    parsed = raw && raw.trim() !== "" ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "invalid_body", "corpo da requisicao invalido (JSON esperado)");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HttpError(
      options.validationStatus ?? 400,
      "validation_error",
      formatZodError(result.error),
    );
  }
  return result.data;
}

/** Agrega as mensagens do ZodError em uma string legivel (campo: motivo). */
function formatZodError(error: ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(corpo)";
    return `${path}: ${issue.message}`;
  });
  return `dados invalidos -> ${parts.join("; ")}`;
}

// ---------------------------------------------------------------------
// Schema: credencial Effecti (PUT /fontes/effecti/credencial).
// token e secret: string nao-vazia (token vazio bloqueado server-side).
// ---------------------------------------------------------------------
export const effectiCredentialSchema = z
  .object({
    token: z
      .string({
        required_error: "token e obrigatorio",
        invalid_type_error: "token deve ser string",
      })
      .trim()
      .min(1, "token nao pode ser vazio"),
  })
  .strict();

export type EffectiCredentialInput = z.infer<typeof effectiCredentialSchema>;

// ---------------------------------------------------------------------
// Schema: configuracao da ingestao (PUT /ingestao/config).
// Regras (secao 4.5.1): janelaDias inteiro em [1, MAX]; modalidades/portais
// nao-vazios (cada item string nao-vazia, deduplicados).
// ---------------------------------------------------------------------
const stringItems = (label: string) =>
  z
    .string({ invalid_type_error: `${label} deve conter apenas strings` })
    .trim()
    .min(1, `${label} nao pode conter itens vazios`);

const nonEmptyStringArray = (label: string) =>
  z
    .array(stringItems(label))
    .min(1, `${label} deve ter ao menos um item`)
    .transform((items) => Array.from(new Set(items)));

/** Array de strings que ACEITA lista vazia (vazio => "todos", sem filtro). */
const stringArray = (label: string) =>
  z.array(stringItems(label)).transform((items) => Array.from(new Set(items)));

export const ingestaoConfigSchema = z
  .object({
    frequencia: z.enum(FREQUENCIAS, {
      errorMap: () => ({
        message: `frequencia invalida (use: ${FREQUENCIAS.join(", ")})`,
      }),
    }),
    janelaDias: z
      .number({
        required_error: "janelaDias e obrigatorio",
        invalid_type_error: "janelaDias deve ser numero",
      })
      .int("janelaDias deve ser inteiro")
      .min(MIN_JANELA_DIAS, `janelaDias deve ser >= ${MIN_JANELA_DIAS}`)
      .max(MAX_JANELA_DIAS, `janelaDias deve ser <= ${MAX_JANELA_DIAS}`),
    modalidades: stringArray("modalidades"),
    portais: nonEmptyStringArray("portais"),
  })
  .strict();

export type IngestaoConfigInput = z.infer<typeof ingestaoConfigSchema>;

// ---------------------------------------------------------------------
// Allowlists parametrizadas por fonte (US-03, SEC-03).
// `fonte` e um enum fechado; `recursos` tem as chaves validadas contra uma
// allowlist fixa. Qualquer valor desconhecido vira erro de schema (422 na
// borda) ANTES de qualquer I/O externo (nenhuma chamada de API/Vault).
// ---------------------------------------------------------------------
export const FONTES = ["effecti", "nomus"] as const;
export type Fonte = (typeof FONTES)[number];

export const fonteEnum = z.enum(FONTES, {
  errorMap: () => ({ message: `fonte invalida (use: ${FONTES.join(", ")})` }),
});

/**
 * Resolve/valida o parametro `fonte` de uma query string (GET). Ausente ->
 * default 'effecti' (fonte padrao do MVP); valor presente e invalido -> 422.
 */
export function parseFonteParam(value: string | null): Fonte {
  const result = fonteEnum.safeParse(value ?? "effecti");
  if (!result.success) {
    throw new HttpError(422, "validation_error", `fonte invalida (use: ${FONTES.join(", ")})`);
  }
  return result.data;
}

/** Allowlist de recursos da fonte multi-recurso (Nomus) — secao 2.4 da SPEC. */
export const RECURSOS_PERMITIDOS = [
  "processos",
  "cobranca",
  "propostas",
  "pedidos",
  "nfes",
  "contas_a_receber",
] as const;
export type RecursoKey = (typeof RECURSOS_PERMITIDOS)[number];

/**
 * Config por recurso (config_ingestao.recursos.<recurso>). Campos governados
 * nesta entrega: ativo/tipos_ativos/usa_filtro_data_alteracao. etapas_terminais
 * e aceito (passthrough) para nao ser perdido em toggles; chaves desconhecidas
 * sao rejeitadas (strict).
 */
const recursoConfigSchema = z
  .object({
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
    tipos_ativos: z
      .array(stringItems("tipos_ativos"))
      .transform((items) => Array.from(new Set(items)))
      .optional(),
    usa_filtro_data_alteracao: z
      .boolean({ invalid_type_error: "usa_filtro_data_alteracao deve ser booleano" })
      .optional(),
    etapas_terminais: z
      .array(stringItems("etapas_terminais"))
      .transform((items) => Array.from(new Set(items)))
      .optional(),
  })
  .strict();

export type RecursoConfigInput = z.infer<typeof recursoConfigSchema>;

/** Campo janelaDias compartilhado (inteiro em [MIN, MAX]). */
const janelaDiasField = () =>
  z
    .number({
      required_error: "janelaDias e obrigatorio",
      invalid_type_error: "janelaDias deve ser numero",
    })
    .int("janelaDias deve ser inteiro")
    .min(MIN_JANELA_DIAS, `janelaDias deve ser >= ${MIN_JANELA_DIAS}`)
    .max(MAX_JANELA_DIAS, `janelaDias deve ser <= ${MAX_JANELA_DIAS}`);

// ---------------------------------------------------------------------
// Schema: credencial parametrizada por fonte (PUT /fontes-credencial).
// fonte enum {effecti,nomus} (default effecti); token string nao-vazia.
// ---------------------------------------------------------------------
export const fonteCredentialSchema = z
  .object({
    fonte: fonteEnum.default("effecti"),
    token: z
      .string({
        required_error: "token e obrigatorio",
        invalid_type_error: "token deve ser string",
      })
      .trim()
      .min(1, "token nao pode ser vazio"),
  })
  .strict();

export type FonteCredentialInput = z.infer<typeof fonteCredentialSchema>;

// ---------------------------------------------------------------------
// Schema: teste de conexao parametrizado por fonte (POST /fontes-testar).
// ---------------------------------------------------------------------
export const testarConexaoSchema = z
  .object({
    fonte: fonteEnum.default("effecti"),
  })
  .strict();

export type TestarConexaoInput = z.infer<typeof testarConexaoSchema>;

// ---------------------------------------------------------------------
// Schema: config de ingestao parametrizada por fonte (PUT /ingestao-config).
// Contrato desta entrega (snake_case): fonte, janela_dias, data_inicial,
// recursos. Mantem os aliases/filtros legados do Effecti (janelaDias,
// frequencia, modalidades, portais) como OPCIONAIS para nao quebrar o form
// existente do cockpit; o handler persiste apenas os campos presentes.
//   - data_inicial: aceita no corpo mas NAO exposta na UI; quando preenchida
//     sobrepoe janela_dias na coleta.
//   - recursos: chaves validadas contra RECURSOS_PERMITIDOS (allowlist).
// ---------------------------------------------------------------------
export const ingestaoConfigUpsertSchema = z
  .object({
    fonte: fonteEnum.default("effecti"),
    janela_dias: janelaDiasField().optional(),
    janelaDias: janelaDiasField().optional(),
    data_inicial: z
      .string({ invalid_type_error: "data_inicial deve ser string (YYYY-MM-DD)" })
      .regex(/^\d{4}-\d{2}-\d{2}$/, "data_inicial invalida (use YYYY-MM-DD)")
      .nullish(),
    recursos: z.record(z.enum(RECURSOS_PERMITIDOS), recursoConfigSchema).optional(),
    frequencia: z
      .enum(FREQUENCIAS, {
        errorMap: () => ({ message: `frequencia invalida (use: ${FREQUENCIAS.join(", ")})` }),
      })
      .optional(),
    modalidades: stringArray("modalidades").optional(),
    portais: nonEmptyStringArray("portais").optional(),
  })
  .strict();

export type IngestaoConfigUpsertInput = z.infer<typeof ingestaoConfigUpsertSchema>;

// ---------------------------------------------------------------------
// Schema: agendamento GLOBAL do ciclo (PUT /agendamento/config).
// Relogio unico (singleton) que governa o pg_cron via aplicar_agendamento().
// horarioReferencia em 'HH:MM' (local America/Sao_Paulo); diaSemana/diaMes
// so fazem sentido em 'semanal'/'mensal'. 'manual' desliga o ciclo.
// ---------------------------------------------------------------------
export const agendamentoConfigSchema = z
  .object({
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }),
    frequencia: z.enum(FREQUENCIAS, {
      errorMap: () => ({ message: `frequencia invalida (use: ${FREQUENCIAS.join(", ")})` }),
    }),
    horarioReferencia: z
      .string({ invalid_type_error: "horarioReferencia deve ser string" })
      .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "horario invalido (use HH:MM, 00:00 a 23:59)")
      .nullish(),
    diaSemana: z
      .number({ invalid_type_error: "diaSemana deve ser numero" })
      .int("diaSemana deve ser inteiro")
      .min(0, "diaSemana deve estar entre 0 (dom) e 6 (sab)")
      .max(6, "diaSemana deve estar entre 0 (dom) e 6 (sab)")
      .nullish(),
    diaMes: z
      .number({ invalid_type_error: "diaMes deve ser numero" })
      .int("diaMes deve ser inteiro")
      .min(1, "diaMes deve estar entre 1 e 28")
      .max(28, "diaMes deve estar entre 1 e 28")
      .nullish(),
  })
  .strict();

export type AgendamentoConfigInput = z.infer<typeof agendamentoConfigSchema>;

// ---------------------------------------------------------------------
// Schema: agendamento POR FONTE (PUT /agendamento-fonte-config).
// Substitui o ciclo global: cada fonte tem seu proprio relogio, persistido na
// config_ingestao da fonte e materializado no pg_cron via
// aplicar_agendamento_fonte(tipo). `fonte` enum {effecti,nomus} (default
// effecti). Demais campos espelham o agendamento global.
// ---------------------------------------------------------------------
export const agendamentoFonteConfigSchema = z
  .object({
    fonte: fonteEnum.default("effecti"),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }),
    frequencia: z.enum(FREQUENCIAS, {
      errorMap: () => ({ message: `frequencia invalida (use: ${FREQUENCIAS.join(", ")})` }),
    }),
    horarioReferencia: z
      .string({ invalid_type_error: "horarioReferencia deve ser string" })
      .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "horario invalido (use HH:MM, 00:00 a 23:59)")
      .nullish(),
    diaSemana: z
      .number({ invalid_type_error: "diaSemana deve ser numero" })
      .int("diaSemana deve ser inteiro")
      .min(0, "diaSemana deve estar entre 0 (dom) e 6 (sab)")
      .max(6, "diaSemana deve estar entre 0 (dom) e 6 (sab)")
      .nullish(),
    diaMes: z
      .number({ invalid_type_error: "diaMes deve ser numero" })
      .int("diaMes deve ser inteiro")
      .min(1, "diaMes deve estar entre 1 e 28")
      .max(28, "diaMes deve estar entre 1 e 28")
      .nullish(),
  })
  .strict();

export type AgendamentoFonteConfigInput = z.infer<typeof agendamentoFonteConfigSchema>;

// ---------------------------------------------------------------------
// Schema: coleta sob demanda / agendada (POST /ingestao/coletar).
// fonte enum {effecti,nomus} (default effecti, extensivel - RF-11). recurso
// (allowlist {processos}) so se aplica a fontes multi-recurso (Nomus); para
// o Effecti permanece ausente. janelaDias opcional: quando ausente, herda de
// config_ingestao. gatilho 'agendada' usado pelo pg_cron; default 'manual'
// para disparo sob demanda.
// ---------------------------------------------------------------------
export const GATILHOS = ["manual", "agendada"] as const;
export type Gatilho = (typeof GATILHOS)[number];

/** Recursos coletaveis sob demanda nesta entrega (Nomus). */
export const COLETAR_RECURSOS = ["processos"] as const;
export type ColetarRecurso = (typeof COLETAR_RECURSOS)[number];

export const coletarSchema = z
  .object({
    fonte: fonteEnum.default("effecti"),
    recurso: z
      .enum(COLETAR_RECURSOS, {
        errorMap: () => ({ message: `recurso invalido (use: ${COLETAR_RECURSOS.join(", ")})` }),
      })
      .optional(),
    janelaDias: z
      .number({ invalid_type_error: "janelaDias deve ser numero" })
      .int("janelaDias deve ser inteiro")
      .min(MIN_JANELA_DIAS, `janelaDias deve ser >= ${MIN_JANELA_DIAS}`)
      .max(MAX_JANELA_DIAS, `janelaDias deve ser <= ${MAX_JANELA_DIAS}`)
      .optional(),
    gatilho: z
      .enum(GATILHOS, {
        errorMap: () => ({ message: `gatilho invalido (use: ${GATILHOS.join(", ")})` }),
      })
      .optional(),
  })
  .strict();

export type ColetarInput = z.infer<typeof coletarSchema>;

// ---------------------------------------------------------------------
// Schema: busca semantica multi-origem /v1 (POST /v1/substrato/busca-semantica).
// query: string nao-vazia (query vazia rejeitada por validacao) e limitada a
// MAX_QUERY_CHARS para evitar abuso (>limite -> 422 na borda).
// limite: opcional, normalizado/limitado em [MIN_LIMITE, MAX_LIMITE]
//   (default DEFAULT_LIMITE) — clamp aplicado no handler (L-05).
// escopo: opcional, default 'tudo' (federado). Mapeado 1:1 para p_escopo da
//   RPC origem-aware (tudo|avisos|processos|<tipo>), DD-03.
// topK: ALIAS LEGADO de `limite` mantido para nao quebrar o playground do
//   cockpit (envia topK) sob o schema .strict() — mudanca estritamente aditiva.
// ---------------------------------------------------------------------
export const MIN_TOP_K = 1;
export const MAX_TOP_K = 50;
export const DEFAULT_TOP_K = 5;

/** Clamp do limite (top-K) da busca: [MIN_LIMITE, MAX_LIMITE], default DEFAULT_LIMITE. */
export const MIN_LIMITE = 1;
export const MAX_LIMITE = 50;
export const DEFAULT_LIMITE = 10;

export const MAX_QUERY_CHARS = 2_000;

/**
 * Escopos aceitos pela busca multi-origem (mapeados 1:1 para p_escopo da RPC):
 *   - 'tudo'   -> federado (avisos + processos)
 *   - 'avisos' -> somente aviso_chunks (editais)
 *   - 'processos' -> memoria_chunks origem='processo'
 *   - 'processo-venda-governamental' -> filtro fino por tipo do chunk
 * Chunk de processo nunca polui a consulta de edital e vice-versa.
 */
export const ESCOPOS = ["tudo", "avisos", "processos", "processo-venda-governamental"] as const;
export type Escopo = (typeof ESCOPOS)[number];

export const escopoEnum = z.enum(ESCOPOS, {
  errorMap: () => ({ message: `escopo invalido (use: ${ESCOPOS.join(", ")})` }),
});

/** Campo de limite/top-K compartilhado (inteiro positivo, opcional). */
const limiteField = (label: string) =>
  z
    .number({ invalid_type_error: `${label} deve ser numero` })
    .int(`${label} deve ser inteiro`)
    .positive(`${label} deve ser positivo`)
    .optional();

export const buscaSemanticaSchema = z
  .object({
    query: z
      .string({
        required_error: "query e obrigatoria",
        invalid_type_error: "query deve ser string",
      })
      .trim()
      .min(1, "query nao pode ser vazia")
      .max(MAX_QUERY_CHARS, `query nao pode exceder ${MAX_QUERY_CHARS} caracteres`),
    limite: limiteField("limite"),
    // Alias legado: o playground do cockpit ainda envia topK (compat aditiva).
    topK: limiteField("topK"),
    escopo: escopoEnum.default("tudo"),
  })
  .strict();

export type BuscaSemanticaInput = z.infer<typeof buscaSemanticaSchema>;

/**
 * Normaliza/limita o limite (top-K) ao intervalo suportado pelo substrato.
 * Ausente -> DEFAULT_LIMITE; fora dos limites -> clamp em [MIN_LIMITE, MAX_LIMITE].
 */
export function normalizeLimite(limite: number | undefined): number {
  if (limite === undefined) return DEFAULT_LIMITE;
  return Math.min(Math.max(Math.trunc(limite), MIN_LIMITE), MAX_LIMITE);
}

/**
 * Normaliza/limita o topK do payload (compat legada). Mantido para consumidores
 * que ainda referenciam o nome antigo; delega ao mesmo clamp do limite.
 */
export function normalizeTopK(topK: number | undefined): number {
  if (topK === undefined) return DEFAULT_TOP_K;
  return Math.min(Math.max(Math.trunc(topK), MIN_TOP_K), MAX_TOP_K);
}

// ---------------------------------------------------------------------
// Schema: gestao do token de servico da Lia (POST /v1/lia/token).
// action: 'rotate' emite/rotaciona uma nova API key; 'revoke' a invalida.
// ---------------------------------------------------------------------
export const LIA_TOKEN_ACTIONS = ["rotate", "revoke"] as const;
export type LiaTokenAction = (typeof LIA_TOKEN_ACTIONS)[number];

export const liaTokenActionSchema = z
  .object({
    action: z.enum(LIA_TOKEN_ACTIONS, {
      errorMap: () => ({
        message: `action invalida (use: ${LIA_TOKEN_ACTIONS.join(", ")})`,
      }),
    }),
  })
  .strict();

export type LiaTokenActionInput = z.infer<typeof liaTokenActionSchema>;

// ---------------------------------------------------------------------
// Schema: parametros da camada 1 do extrator (PUT /extracao-config).
// Singleton GLOBAL (config_extracao): o runner Node le no inicio do job.
// Contrato camelCase (espelha config_extracao.* em snake). Limites altos o
// suficiente para qualquer documento real, mas finitos para barrar abuso.
//   ocrEstrategia        'auto' | 'nunca' | 'sempre' (mapeia no Tika)
//   ocrIdioma            codigos Tesseract ('por+eng')
//   tamanhoMaxBytes      teto por arquivo (acima => pula); 1 GiB hard-cap
//   timeoutMs            timeout por arquivo no Tika; min 1s, max 30min
//   extensoesHabilitadas null = todas; array = allowlist (sem ponto)
//   loteTamanho          arquivos por lote antes da pausa
//   pausaLoteMs          pausa entre lotes (alivia o Tika)
// ---------------------------------------------------------------------
export const OCR_ESTRATEGIAS = ["auto", "nunca", "sempre"] as const;
export type OcrEstrategia = (typeof OCR_ESTRATEGIAS)[number];

// Fontes que o extrator sabe obter bytes (adaptadores em extrair-anexos.mjs).
// null em fontes_habilitadas = TODAS (default, futuro-prova).
export const FONTES_EXTRACAO = ["nomus", "effecti", "drive", "gmail"] as const;
export type FonteExtracao = (typeof FONTES_EXTRACAO)[number];

const MAX_TAMANHO_BYTES = 1_073_741_824; // 1 GiB
const MAX_TIMEOUT_MS = 1_800_000; // 30 min
const MAX_LOTE = 1_000;
const MAX_PAUSA_MS = 600_000; // 10 min

export const extracaoConfigSchema = z
  .object({
    ocrEstrategia: z.enum(OCR_ESTRATEGIAS, {
      errorMap: () => ({
        message: `ocrEstrategia invalida (use: ${OCR_ESTRATEGIAS.join(", ")})`,
      }),
    }),
    ocrIdioma: z
      .string({ invalid_type_error: "ocrIdioma deve ser string" })
      .trim()
      .min(1, "ocrIdioma nao pode ser vazio")
      .max(120, "ocrIdioma muito longo")
      .regex(/^[a-z+]+$/i, "ocrIdioma deve usar codigos Tesseract (ex.: por+eng)"),
    tamanhoMaxBytes: z
      .number({ invalid_type_error: "tamanhoMaxBytes deve ser numero" })
      .int("tamanhoMaxBytes deve ser inteiro")
      .positive("tamanhoMaxBytes deve ser positivo")
      .max(MAX_TAMANHO_BYTES, "tamanhoMaxBytes excede o teto (1 GiB)"),
    timeoutMs: z
      .number({ invalid_type_error: "timeoutMs deve ser numero" })
      .int("timeoutMs deve ser inteiro")
      .min(1_000, "timeoutMs deve ser >= 1000")
      .max(MAX_TIMEOUT_MS, "timeoutMs excede o teto (30 min)"),
    extensoesHabilitadas: z
      .array(
        stringItems("extensoesHabilitadas").transform((e) =>
          e.toLowerCase().replace(/^\./, ""),
        ),
      )
      .transform((items) => Array.from(new Set(items.filter((e) => e.length > 0))))
      .nullable(),
    loteTamanho: z
      .number({ invalid_type_error: "loteTamanho deve ser numero" })
      .int("loteTamanho deve ser inteiro")
      .min(1, "loteTamanho deve ser >= 1")
      .max(MAX_LOTE, `loteTamanho deve ser <= ${MAX_LOTE}`),
    pausaLoteMs: z
      .number({ invalid_type_error: "pausaLoteMs deve ser numero" })
      .int("pausaLoteMs deve ser inteiro")
      .min(0, "pausaLoteMs deve ser >= 0")
      .max(MAX_PAUSA_MS, "pausaLoteMs excede o teto (10 min)"),
    // Allowlist de fontes: null/ausente = todas; array = subconjunto. Dedup
    // e normaliza; array vazio cai para null (= todas) no Edge.
    fontesHabilitadas: z
      .array(
        z.enum(FONTES_EXTRACAO, {
          errorMap: () => ({
            message: `fonte invalida (use: ${FONTES_EXTRACAO.join(", ")})`,
          }),
        }),
      )
      .transform((items) => Array.from(new Set(items)))
      .nullable()
      .optional(),
  })
  .strict();

export type ExtracaoConfigInput = z.infer<typeof extracaoConfigSchema>;
