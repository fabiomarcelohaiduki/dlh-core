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

/**
 * Fontes AGENDAVEIS pelo card (cada uma com relogio proprio). Inclui o Gmail,
 * que tambem coleta no GitHub Actions (coletar-gmail.yml). NAO amplia o enum
 * `FONTES` (usado por credencial/teste/config/coleta), que segue restrito a
 * effecti|nomus — o Gmail nao usa esses contratos (autentica por OAuth e
 * configura via gmail-config).
 */
export const FONTES_AGENDAVEIS = ["effecti", "nomus", "gmail", "drive"] as const;
export type FonteAgendavel = (typeof FONTES_AGENDAVEIS)[number];

export const fonteAgendavelEnum = z.enum(FONTES_AGENDAVEIS, {
  errorMap: () => ({ message: `fonte invalida (use: ${FONTES_AGENDAVEIS.join(", ")})` }),
});

/** Idem parseFonteParam, mas para o agendamento por fonte (inclui gmail). */
export function parseFonteAgendavelParam(value: string | null): FonteAgendavel {
  const result = fonteAgendavelEnum.safeParse(value ?? "effecti");
  if (!result.success) {
    throw new HttpError(
      422,
      "validation_error",
      `fonte invalida (use: ${FONTES_AGENDAVEIS.join(", ")})`,
    );
  }
  return result.data;
}

/** Allowlist de recursos da fonte multi-recurso (Nomus) — secao 2.4 da SPEC. */
export const RECURSOS_PERMITIDOS = [
  "processos",
  "pessoas",
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
 *
 * JANELA POR RECURSO (floor independente, ex.: "processos a partir do id
 * 25000"): id_inicial corta por nomus_id (modulos sequenciais por id) e
 * data_inicial corta por data de criacao. Ambos opcionais; null limpa o corte
 * (merge raso do Edge sobrepoe). Substituem o data_inicial GLOBAL (top-level),
 * que vira fallback legado quando o recurso nao define janela propria.
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
    id_inicial: z
      .number({ invalid_type_error: "id_inicial deve ser numero" })
      .int("id_inicial deve ser inteiro")
      .nonnegative("id_inicial nao pode ser negativo")
      .nullable()
      .optional(),
    data_inicial: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "data_inicial do recurso deve ser YYYY-MM-DD")
      .nullable()
      .optional(),
    // Janela DESLIZANTE do FULL (retencao): corte = hoje - janela_dias,
    // recalculado a cada coleta. Limita o full ao historico recente (ex.: 1095
    // = 3 anos) p/ nao crescer com o tempo. Tem prioridade sobre data_inicial.
    janela_dias: z
      .number({ invalid_type_error: "janela_dias deve ser numero" })
      .int("janela_dias deve ser inteiro")
      .positive("janela_dias deve ser positivo")
      .max(3650, "janela_dias deve ser <= 3650 (10 anos)")
      .nullable()
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
// Schema: credencial do PAINEL WEB da Effecti (PUT /effecti-painel-cred).
// Login programatico usuario/senha -> JWT (habilita o endpoint /all de recall
// total). Ambos nao-vazios apos trim; segredo so trafega na ida (RNF-02).
// ---------------------------------------------------------------------
export const effectiPainelCredSchema = z
  .object({
    username: z
      .string({
        required_error: "username e obrigatorio",
        invalid_type_error: "username deve ser string",
      })
      .trim()
      .min(1, "username nao pode ser vazio")
      .max(200, "username muito longo"),
    password: z
      .string({
        required_error: "password e obrigatorio",
        invalid_type_error: "password deve ser string",
      })
      .min(1, "password nao pode ser vazio")
      .max(400, "password muito longa"),
  })
  .strict();

export type EffectiPainelCredInput = z.infer<typeof effectiPainelCredSchema>;

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
// aplicar_agendamento_fonte(tipo). `fonte` enum {effecti,nomus,gmail} (default
// effecti). Demais campos espelham o agendamento global.
// ---------------------------------------------------------------------
export const agendamentoFonteConfigSchema = z
  .object({
    fonte: fonteAgendavelEnum.default("effecti"),
    // recurso opcional: presente => agendamento POR MODULO (jsonb
    // recursos.<recurso>.agendamento, ex.: Nomus/processos); ausente =>
    // agendamento POR FONTE (colunas top-level, Effecti/Gmail).
    recurso: z
      .enum(RECURSOS_PERMITIDOS, {
        errorMap: () => ({ message: `recurso invalido (use: ${RECURSOS_PERMITIDOS.join(", ")})` }),
      })
      .optional(),
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
    // Retomada manual (botao "Retomar" do painel, so Effecti): id da execucao
    // em erro a retomar a partir do checkpoint EXATO, em vez de recomecar do
    // bloco 1. Ignorado pelo Nomus (handleNomus inicia coleta nova).
    retomarExecucaoId: z
      .string({ invalid_type_error: "retomarExecucaoId deve ser string" })
      .uuid("retomarExecucaoId deve ser UUID")
      .optional(),
  })
  .strict();

export type ColetarInput = z.infer<typeof coletarSchema>;

// ---------------------------------------------------------------------
// Schema: disparo MANUAL do workflow Nomus (POST /nomus-disparar).
// O Nomus coleta no runner do GitHub Actions (TLS legado); este endpoint
// aciona o workflow_dispatch sob demanda pelo card da fonte. modo escolhe
// entre incremental (regime permanente) e full (backfill historico).
// ---------------------------------------------------------------------
export const NOMUS_MODOS = ["incremental", "full"] as const;
export type NomusModo = (typeof NOMUS_MODOS)[number];

export const nomusDispararSchema = z
  .object({
    modo: z.enum(NOMUS_MODOS, {
      errorMap: () => ({ message: `modo invalido (use: ${NOMUS_MODOS.join(", ")})` }),
    }),
    // recurso/modulo alvo do disparo manual. Default 'processos' aplicado no
    // Edge/RPC (unico coletor vivo hoje); os demais ficam inertes.
    recurso: z
      .enum(RECURSOS_PERMITIDOS, {
        errorMap: () => ({ message: `recurso invalido (use: ${RECURSOS_PERMITIDOS.join(", ")})` }),
      })
      .optional(),
  })
  .strict();

export type NomusDispararInput = z.infer<typeof nomusDispararSchema>;

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
// Schema: leitura integral de documento do acervo /v1
//   (POST /v1/acervo/ler-documento). documento_id: UUID obrigatorio.
//   offset: chars a pular (>=0, default 0). limite: tamanho da janela em
//   chars, normalizado/limitado em [1, MAX_DOC_CHARS] (default
//   DEFAULT_DOC_CHARS) — clamp aplicado no handler, espelhando a RPC.
// ---------------------------------------------------------------------
export const MIN_DOC_CHARS = 1;
export const MAX_DOC_CHARS = 200_000;
export const DEFAULT_DOC_CHARS = 50_000;

export const acervoLerDocumentoSchema = z
  .object({
    documento_id: z
      .string({
        required_error: "documento_id e obrigatorio",
        invalid_type_error: "documento_id deve ser string",
      })
      .uuid("documento_id deve ser UUID"),
    offset: z
      .number({ invalid_type_error: "offset deve ser numero" })
      .int("offset deve ser inteiro")
      .nonnegative("offset deve ser >= 0")
      .optional(),
    limite: z
      .number({ invalid_type_error: "limite deve ser numero" })
      .int("limite deve ser inteiro")
      .positive("limite deve ser positivo")
      .optional(),
  })
  .strict();

export type AcervoLerDocumentoInput = z.infer<typeof acervoLerDocumentoSchema>;

/** Normaliza o offset de leitura do acervo: ausente/negativo -> 0. */
export function normalizeDocOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  return Math.max(Math.trunc(offset), 0);
}

/**
 * Normaliza/limita a janela de leitura do acervo (em chars) ao intervalo
 * suportado. Ausente -> DEFAULT_DOC_CHARS; fora -> clamp em [MIN, MAX].
 */
export function normalizeDocLimite(limite: number | undefined): number {
  if (limite === undefined) return DEFAULT_DOC_CHARS;
  return Math.min(Math.max(Math.trunc(limite), MIN_DOC_CHARS), MAX_DOC_CHARS);
}

// ---------------------------------------------------------------------
// Schema: SQL read-only no substrato tabular /v1 (POST /v1-substrato-sql).
//   Tool #4 do RAG. A Lia ESCREVE um unico SELECT/WITH sobre as views
//   curadas do schema lia; a RPC executar_sql_lia aplica as travas
//   deterministicas (owner read-only lia_sql, search_path lia, SELECT-only,
//   statement_timeout 5s, LIMIT). Aqui so validamos o ENVELOPE: sql nao-vazio
//   ate MAX_SQL_CHARS; limite opcional clampado em [1, MAX_SQL_LINHAS] (a RPC
//   reforca o mesmo teto). A seguranca REAL vive na RPC, nao neste schema.
// ---------------------------------------------------------------------
export const MAX_SQL_CHARS = 8_000;
export const MIN_SQL_LINHAS = 1;
export const MAX_SQL_LINHAS = 1_000;
export const DEFAULT_SQL_LINHAS = 1_000;

export const substratoSqlSchema = z
  .object({
    sql: z
      .string({
        required_error: "sql e obrigatorio",
        invalid_type_error: "sql deve ser string",
      })
      .trim()
      .min(1, "sql nao pode ser vazio")
      .max(MAX_SQL_CHARS, `sql nao pode exceder ${MAX_SQL_CHARS} caracteres`),
    limite: z
      .number({ invalid_type_error: "limite deve ser numero" })
      .int("limite deve ser inteiro")
      .positive("limite deve ser positivo")
      .optional(),
  })
  .strict();

export type SubstratoSqlInput = z.infer<typeof substratoSqlSchema>;

/**
 * Normaliza/limita o teto de linhas do SQL ao intervalo suportado.
 * Ausente -> DEFAULT_SQL_LINHAS; fora -> clamp em [MIN, MAX] (a RPC reforca).
 */
export function normalizeSqlLinhas(limite: number | undefined): number {
  if (limite === undefined) return DEFAULT_SQL_LINHAS;
  return Math.min(Math.max(Math.trunc(limite), MIN_SQL_LINHAS), MAX_SQL_LINHAS);
}

// ---------------------------------------------------------------------
// Schema: busca semantica do dominio Produtos /v1 (POST /v1-produtos-busca-semantica).
// Diferente da busca multi-origem do substrato: o escopo e FIXO em
// 'produto-cotacao' (definido no handler, nao no corpo) e o `limite` e
// VALIDADO (nao clampado): valores acima do maximo sao REJEITADOS com 400
// (criterio de aceite do Dominio F). query obrigatoria, 1..MAX_QUERY_CHARS.
// ---------------------------------------------------------------------
export const PRODUTOS_BUSCA_DEFAULT_LIMITE = 10;
export const PRODUTOS_BUSCA_MAX_LIMITE = 50;

/** Escopo fixo do dominio Produtos no enum /v1 estendido (RF-24/RF-25). */
export const PRODUTOS_BUSCA_ESCOPO = "produto-cotacao" as const;

export const produtosBuscaSemanticaSchema = z
  .object({
    query: z
      .string({
        required_error: "query e obrigatoria",
        invalid_type_error: "query deve ser string",
      })
      .trim()
      .min(1, "query nao pode ser vazia")
      .max(MAX_QUERY_CHARS, `query nao pode exceder ${MAX_QUERY_CHARS} caracteres`),
    // Diferente do substrato: rejeita (nao clampa) limite acima do maximo.
    limite: z
      .number({ invalid_type_error: "limite deve ser numero" })
      .int("limite deve ser inteiro")
      .positive("limite deve ser positivo")
      .max(PRODUTOS_BUSCA_MAX_LIMITE, `limite nao pode exceder ${PRODUTOS_BUSCA_MAX_LIMITE}`)
      .optional(),
  })
  .strict();

export type ProdutosBuscaSemanticaInput = z.infer<typeof produtosBuscaSemanticaSchema>;

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
        stringItems("extensoesHabilitadas").transform((e) => e.toLowerCase().replace(/^\./, "")),
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

// ---------------------------------------------------------------------
// Schema: config da INDEXACAO (embeddings) — PUT /indexacao.
// Singleton config_indexacao. `ativo` = master switch (gasta dinheiro na
// OpenAI quando ON); `fontesHabilitadas` null = todas (gating por fonte no
// continuo e no backfill); `loteChunks` = orcamento de chunks por invocacao
// do backfill (proxy ~2000 chars/chunk); `pausaMs` = pausa entre documentos;
// `tpmAlvo` = teto de tokens/min do pacer (0 = sem pacing);
// `tentativasMax` = teto de tentativas antes de marcar 'erro' definitivo.
// ---------------------------------------------------------------------
const MAX_LOTE_CHUNKS = 10_000;
const MAX_TPM_ALVO = 10_000_000;
const MAX_TENTATIVAS = 10;

export const indexacaoConfigSchema = z
  .object({
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }),
    // Master switch da perna de processos (independente de `ativo`).
    processosAtivo: z.boolean({ invalid_type_error: "processosAtivo deve ser booleano" }),
    // Allowlist de fontes: null/ausente = todas; array = subconjunto.
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
    loteChunks: z
      .number({ invalid_type_error: "loteChunks deve ser numero" })
      .int("loteChunks deve ser inteiro")
      .min(1, "loteChunks deve ser >= 1")
      .max(MAX_LOTE_CHUNKS, `loteChunks deve ser <= ${MAX_LOTE_CHUNKS}`),
    pausaMs: z
      .number({ invalid_type_error: "pausaMs deve ser numero" })
      .int("pausaMs deve ser inteiro")
      .min(0, "pausaMs deve ser >= 0")
      .max(MAX_PAUSA_MS, "pausaMs excede o teto (10 min)"),
    tpmAlvo: z
      .number({ invalid_type_error: "tpmAlvo deve ser numero" })
      .int("tpmAlvo deve ser inteiro")
      .min(0, "tpmAlvo deve ser >= 0")
      .max(MAX_TPM_ALVO, `tpmAlvo deve ser <= ${MAX_TPM_ALVO}`),
    tentativasMax: z
      .number({ invalid_type_error: "tentativasMax deve ser numero" })
      .int("tentativasMax deve ser inteiro")
      .min(1, "tentativasMax deve ser >= 1")
      .max(MAX_TENTATIVAS, `tentativasMax deve ser <= ${MAX_TENTATIVAS}`),
  })
  .strict();

export type IndexacaoConfigInput = z.infer<typeof indexacaoConfigSchema>;

// ---------------------------------------------------------------------
// Schema: agendamento da EXTRACAO (PUT /extracao-agendamento).
// Mora no singleton config_extracao (colunas de agendamento, separadas dos
// parametros do Tika) e materializa o pg_cron 'extrair-anexos' via
// aplicar_agendamento_extracao(). Sem `fonte`/`recurso`: o extrator e global
// (drena a fila inteira). Campos espelham agendamentoFonteConfigSchema.
// ---------------------------------------------------------------------
export const extracaoAgendamentoSchema = z
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

export type ExtracaoAgendamentoInput = z.infer<typeof extracaoAgendamentoSchema>;

// =====================================================================
// Dominio A (Produtos): Linhas, Atributos, Produtos e SKUs (secao 3.2).
// Payloads JSON em snake_case; .strict() rejeita chaves desconhecidas (400).
// Validacao semantica adicional (atributos x schema da Linha, coerencia de
// tipo_origem) e feita no handler — aqui ficam apenas as regras de forma.
// =====================================================================

/** Paginacao offset-based padrao: limit default 50, max 200, offset >= 0. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export interface Pagination {
  limit: number;
  offset: number;
}

/**
 * Resolve limit/offset da query string com clamp seguro. Valores invalidos ou
 * ausentes caem no default; limit e limitado a MAX_PAGE_LIMIT.
 */
export function parsePagination(url: URL): Pagination {
  const rawLimit = Number(url.searchParams.get("limit"));
  const rawOffset = Number(url.searchParams.get("offset"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), MAX_PAGE_LIMIT)
    : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.trunc(rawOffset) : 0;
  return { limit, offset };
}

/**
 * Interpreta o filtro booleano opcional ?ativo= (true/false). Ausente/invalido
 * retorna undefined (sem filtro).
 */
export function parseBooleanFilter(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return undefined;
}

// ---------------------------------------------------------------------
// produto_linhas (CRUD). POST exige nome; PUT aceita campos parciais (inclui
// ativo). nome unico e validado no banco (UNIQUE) -> 409 no handler.
// ---------------------------------------------------------------------
export const produtoLinhaCreateSchema = z
  .object({
    nome: z
      .string({ required_error: "nome e obrigatorio", invalid_type_error: "nome deve ser string" })
      .trim()
      .min(1, "nome nao pode ser vazio"),
    descricao: z.string({ invalid_type_error: "descricao deve ser string" }).trim().nullish(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
    produto_capa_id: z
      .string({ invalid_type_error: "produto_capa_id deve ser string" })
      .uuid("produto_capa_id deve ser um uuid")
      .nullish(),
  })
  .strict();

export type ProdutoLinhaCreateInput = z.infer<typeof produtoLinhaCreateSchema>;

export const produtoLinhaUpdateSchema = z
  .object({
    nome: z
      .string({ invalid_type_error: "nome deve ser string" })
      .trim()
      .min(1, "nome nao pode ser vazio")
      .optional(),
    descricao: z.string({ invalid_type_error: "descricao deve ser string" }).trim().nullish(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
    produto_capa_id: z
      .string({ invalid_type_error: "produto_capa_id deve ser string" })
      .uuid("produto_capa_id deve ser um uuid")
      .nullish(),
  })
  .strict();

export type ProdutoLinhaUpdateInput = z.infer<typeof produtoLinhaUpdateSchema>;

// ---------------------------------------------------------------------
// produto_linha_atributos (CRUD sob /:id/atributos). tipo limitado ao CHECK
// do schema; chave unica por linha validada no banco -> 409 no handler.
// ---------------------------------------------------------------------
export const ATRIBUTO_TIPOS = ["texto", "numero", "booleano"] as const;
export type AtributoTipo = (typeof ATRIBUTO_TIPOS)[number];

export const atributoTipoEnum = z.enum(ATRIBUTO_TIPOS, {
  errorMap: () => ({ message: `tipo invalido (use: ${ATRIBUTO_TIPOS.join(", ")})` }),
});

export const linhaAtributoCreateSchema = z
  .object({
    chave: z
      .string({
        required_error: "chave e obrigatoria",
        invalid_type_error: "chave deve ser string",
      })
      .trim()
      .min(1, "chave nao pode ser vazia"),
    tipo: atributoTipoEnum.optional(),
    obrigatorio: z.boolean({ invalid_type_error: "obrigatorio deve ser booleano" }).optional(),
    mostra_catalogo: z
      .boolean({ invalid_type_error: "mostra_catalogo deve ser booleano" })
      .optional(),
    mostra_ficha: z
      .boolean({ invalid_type_error: "mostra_ficha deve ser booleano" })
      .optional(),
  })
  .strict();

export type LinhaAtributoCreateInput = z.infer<typeof linhaAtributoCreateSchema>;

export const linhaAtributoUpdateSchema = z
  .object({
    chave: z
      .string({ invalid_type_error: "chave deve ser string" })
      .trim()
      .min(1, "chave nao pode ser vazia")
      .optional(),
    tipo: atributoTipoEnum.optional(),
    obrigatorio: z.boolean({ invalid_type_error: "obrigatorio deve ser booleano" }).optional(),
    mostra_catalogo: z
      .boolean({ invalid_type_error: "mostra_catalogo deve ser booleano" })
      .optional(),
    mostra_ficha: z
      .boolean({ invalid_type_error: "mostra_ficha deve ser booleano" })
      .optional(),
  })
  .strict();

export type LinhaAtributoUpdateInput = z.infer<typeof linhaAtributoUpdateSchema>;

// ---------------------------------------------------------------------
// produtos (CRUD). atributos e um mapa JSONB livre na forma; a validacao
// contra o schema da Linha (chave no schema + obrigatorios presentes) e
// semantica e ocorre no handler. POST exige linha_id valido e ativo.
// ---------------------------------------------------------------------
const atributosRecord = z.record(
  z.string(),
  z.unknown(),
  { invalid_type_error: "atributos deve ser um objeto" },
);

export const produtoCreateSchema = z
  .object({
    linha_id: z
      .string({
        required_error: "linha_id e obrigatorio",
        invalid_type_error: "linha_id deve ser string",
      })
      .uuid("linha_id deve ser UUID"),
    nome: z
      .string({ required_error: "nome e obrigatorio", invalid_type_error: "nome deve ser string" })
      .trim()
      .min(1, "nome nao pode ser vazio"),
    descricao: z.string({ invalid_type_error: "descricao deve ser string" }).trim()
      .nullish(),
    atributos: atributosRecord.optional(),
    prazo_entrega: z.string({ invalid_type_error: "prazo_entrega deve ser string" }).trim()
      .nullish(),
    disponibilidade: z
      .string({ invalid_type_error: "disponibilidade deve ser string" })
      .trim()
      .nullish(),
    pedido_minimo: z.string({ invalid_type_error: "pedido_minimo deve ser string" }).trim()
      .nullish(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
  })
  .strict();

export type ProdutoCreateInput = z.infer<typeof produtoCreateSchema>;

export const produtoUpdateSchema = z
  .object({
    linha_id: z
      .string({ invalid_type_error: "linha_id deve ser string" })
      .uuid("linha_id deve ser UUID")
      .optional(),
    nome: z
      .string({ invalid_type_error: "nome deve ser string" })
      .trim()
      .min(1, "nome nao pode ser vazio")
      .optional(),
    descricao: z.string({ invalid_type_error: "descricao deve ser string" }).trim()
      .nullish(),
    atributos: atributosRecord.optional(),
    prazo_entrega: z.string({ invalid_type_error: "prazo_entrega deve ser string" }).trim()
      .nullish(),
    disponibilidade: z
      .string({ invalid_type_error: "disponibilidade deve ser string" })
      .trim()
      .nullish(),
    pedido_minimo: z.string({ invalid_type_error: "pedido_minimo deve ser string" }).trim()
      .nullish(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
  })
  .strict();

export type ProdutoUpdateInput = z.infer<typeof produtoUpdateSchema>;

// ---------------------------------------------------------------------
// produto_skus (CRUD sob /produtos/:id/skus e /skus/:skuId). tipo_origem
// default 'fabricado'; SKU comprado nao pode ter diretriz/tempo de producao
// (coerencia validada no handler). codigo_sku unico -> 409 no handler.
// ---------------------------------------------------------------------
export const SKU_TIPOS_ORIGEM = ["fabricado", "comprado"] as const;
export type SkuTipoOrigem = (typeof SKU_TIPOS_ORIGEM)[number];

/** Origem padrao de um SKU quando nao informada (fonte da verdade no schema). */
export const SKU_TIPO_ORIGEM_DEFAULT: SkuTipoOrigem = "fabricado";

export const skuTipoOrigemEnum = z.enum(SKU_TIPOS_ORIGEM, {
  errorMap: () => ({ message: `tipo_origem invalido (use: ${SKU_TIPOS_ORIGEM.join(", ")})` }),
});

/** Unidade do tempo de lote (converte para horas na derivacao do Edge). */
export const SKU_UNIDADES_TEMPO = ["hora", "dia"] as const;
export type SkuUnidadeTempo = (typeof SKU_UNIDADES_TEMPO)[number];

export const skuUnidadeTempoEnum = z.enum(SKU_UNIDADES_TEMPO, {
  errorMap: () => ({ message: `unidade_tempo invalida (use: ${SKU_UNIDADES_TEMPO.join(", ")})` }),
});

const skuJsonbField = (label: string) =>
  z.record(z.string(), z.unknown(), { invalid_type_error: `${label} deve ser um objeto` })
    .nullish();

const skuNumberField = (label: string) =>
  z.number({ invalid_type_error: `${label} deve ser numero` }).nullish();

export const skuCreateSchema = z
  .object({
    codigo_sku: z
      .string({
        required_error: "codigo_sku e obrigatorio",
        invalid_type_error: "codigo_sku deve ser string",
      })
      .trim()
      .min(1, "codigo_sku nao pode ser vazio"),
    tipo_origem: skuTipoOrigemEnum.default(SKU_TIPO_ORIGEM_DEFAULT),
    atributos: atributosRecord.optional(),
    dimensoes: skuJsonbField("dimensoes"),
    tolerancia_pct: skuNumberField("tolerancia_pct"),
    acabamento: z.string({ invalid_type_error: "acabamento deve ser string" }).trim().nullish(),
    peso_gr: skuNumberField("peso_gr"),
    diretriz_producao: z.string({ invalid_type_error: "diretriz_producao deve ser string" })
      .nullish(),
    tamanho_lote: skuNumberField("tamanho_lote"),
    tempo_lote: skuNumberField("tempo_lote"),
    unidade_tempo: skuUnidadeTempoEnum.nullish(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
  })
  .strict();

export type SkuCreateInput = z.infer<typeof skuCreateSchema>;

export const skuUpdateSchema = z
  .object({
    codigo_sku: z
      .string({ invalid_type_error: "codigo_sku deve ser string" })
      .trim()
      .min(1, "codigo_sku nao pode ser vazio")
      .optional(),
    tipo_origem: skuTipoOrigemEnum.optional(),
    atributos: atributosRecord.optional(),
    dimensoes: skuJsonbField("dimensoes"),
    tolerancia_pct: skuNumberField("tolerancia_pct"),
    acabamento: z.string({ invalid_type_error: "acabamento deve ser string" }).trim().nullish(),
    peso_gr: skuNumberField("peso_gr"),
    diretriz_producao: z.string({ invalid_type_error: "diretriz_producao deve ser string" })
      .nullish(),
    tamanho_lote: skuNumberField("tamanho_lote"),
    tempo_lote: skuNumberField("tempo_lote"),
    unidade_tempo: skuUnidadeTempoEnum.nullish(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
  })
  .strict();

export type SkuUpdateInput = z.infer<typeof skuUpdateSchema>;

// =====================================================================
// Dominio B (Produtos): Insumos, Precos de fornecedor, Composicao (BOM) e
// Custo de aquisicao (secao 3.2). Payloads JSON em snake_case; .strict()
// rejeita chaves desconhecidas (400). Vigencia preservada na borda (sem
// sobrescrever historico); a regra de "preco vigente" mora no motor SQL.
// =====================================================================

/** Campo de data ISO (YYYY-MM-DD). DB faz o cast para o tipo date. */
const dateField = (label: string) =>
  z
    .string({ invalid_type_error: `${label} deve ser string (YYYY-MM-DD)` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} invalida (use YYYY-MM-DD)`);

/** Campo monetario positivo (preco/custo) com mensagem por rotulo. */
const moneyField = (label: string) =>
  z
    .number({
      required_error: `${label} e obrigatorio`,
      invalid_type_error: `${label} deve ser numero`,
    })
    .positive(`${label} deve ser positivo`);

// ---------------------------------------------------------------------
// insumos (CRUD). categoria limitada ao CHECK do schema; insumo em uso so
// sai de circulacao por ativo=false (DELETE bloqueado 409 no handler).
// ---------------------------------------------------------------------
export const INSUMO_CATEGORIAS = ["MP", "embalagem", "insumo"] as const;
export type InsumoCategoria = (typeof INSUMO_CATEGORIAS)[number];

export const insumoCategoriaEnum = z.enum(INSUMO_CATEGORIAS, {
  errorMap: () => ({ message: `categoria invalida (use: ${INSUMO_CATEGORIAS.join(", ")})` }),
});

export const insumoCreateSchema = z
  .object({
    nome: z
      .string({ required_error: "nome e obrigatorio", invalid_type_error: "nome deve ser string" })
      .trim()
      .min(1, "nome nao pode ser vazio"),
    categoria: insumoCategoriaEnum,
    unidade: z
      .string({
        required_error: "unidade e obrigatoria",
        invalid_type_error: "unidade deve ser string",
      })
      .trim()
      .min(1, "unidade nao pode ser vazia"),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
  })
  .strict();

export type InsumoCreateInput = z.infer<typeof insumoCreateSchema>;

export const insumoUpdateSchema = z
  .object({
    nome: z
      .string({ invalid_type_error: "nome deve ser string" })
      .trim()
      .min(1, "nome nao pode ser vazio")
      .optional(),
    categoria: insumoCategoriaEnum.optional(),
    unidade: z
      .string({ invalid_type_error: "unidade deve ser string" })
      .trim()
      .min(1, "unidade nao pode ser vazia")
      .optional(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
  })
  .strict();

export type InsumoUpdateInput = z.infer<typeof insumoUpdateSchema>;

// ---------------------------------------------------------------------
// insumo_precos (POST sob /insumos/:id/precos). Cria nova faixa de vigencia
// preservando o historico (nunca sobrescreve). vigencia_inicio default no DB.
// ---------------------------------------------------------------------
export const insumoPrecoCreateSchema = z
  .object({
    fornecedor: z.string({ invalid_type_error: "fornecedor deve ser string" }).trim().nullish(),
    preco: moneyField("preco"),
    vigencia_inicio: dateField("vigencia_inicio").optional(),
    vigencia_fim: dateField("vigencia_fim").nullish(),
  })
  .strict();

export type InsumoPrecoCreateInput = z.infer<typeof insumoPrecoCreateSchema>;

// ---------------------------------------------------------------------
// insumo-precos/batch (PUT). Edicao EM LOTE: 1..200 updates por requisicao
// (vazio ou > 200 => 400). Cada item cria uma nova faixa de vigencia para o
// insumo; os triggers da sprint 2 recalculam os SKUs afetados (RNF-15).
// ---------------------------------------------------------------------
export const MAX_BATCH_PRECOS = 200;

export const insumoPrecoBatchItemSchema = z
  .object({
    insumo_id: z
      .string({
        required_error: "insumo_id e obrigatorio",
        invalid_type_error: "insumo_id deve ser string",
      })
      .uuid("insumo_id deve ser UUID"),
    preco: moneyField("preco"),
    vigencia_inicio: dateField("vigencia_inicio").optional(),
  })
  .strict();

export const insumoPrecoBatchSchema = z
  .object({
    updates: z
      .array(insumoPrecoBatchItemSchema)
      .min(1, "updates deve ter ao menos 1 item")
      .max(MAX_BATCH_PRECOS, `updates nao pode exceder ${MAX_BATCH_PRECOS} itens`),
  })
  .strict();

export type InsumoPrecoBatchInput = z.infer<typeof insumoPrecoBatchSchema>;

// ---------------------------------------------------------------------
// sku_composicao (CRUD sob /skus/:skuId/composicao e /composicao/:id). SO
// para SKU fabricado (400 no handler se comprado). insumo_id unico por SKU
// (UNIQUE -> 409). insumo inativo nao selecionavel (validado no handler).
// ---------------------------------------------------------------------
export const composicaoCreateSchema = z
  .object({
    insumo_id: z
      .string({
        required_error: "insumo_id e obrigatorio",
        invalid_type_error: "insumo_id deve ser string",
      })
      .uuid("insumo_id deve ser UUID"),
    quantidade: z
      .number({
        required_error: "quantidade e obrigatoria",
        invalid_type_error: "quantidade deve ser numero",
      })
      .positive("quantidade deve ser positiva"),
    unidade: z.string({ invalid_type_error: "unidade deve ser string" }).trim().nullish(),
    // Rendimento opcional: quantas pecas 1 unidade de material rende. Quando
    // presente, o handler deriva quantidade = 1 / rendimento.
    rendimento: z
      .number({ invalid_type_error: "rendimento deve ser numero" })
      .positive("rendimento deve ser positivo")
      .nullish(),
  })
  .strict();

export type ComposicaoCreateInput = z.infer<typeof composicaoCreateSchema>;

export const composicaoUpdateSchema = z
  .object({
    insumo_id: z
      .string({ invalid_type_error: "insumo_id deve ser string" })
      .uuid("insumo_id deve ser UUID")
      .optional(),
    quantidade: z
      .number({ invalid_type_error: "quantidade deve ser numero" })
      .positive("quantidade deve ser positiva")
      .optional(),
    unidade: z.string({ invalid_type_error: "unidade deve ser string" }).trim().nullish(),
    rendimento: z
      .number({ invalid_type_error: "rendimento deve ser numero" })
      .positive("rendimento deve ser positivo")
      .nullish(),
  })
  .strict();

export type ComposicaoUpdateInput = z.infer<typeof composicaoUpdateSchema>;

// ---------------------------------------------------------------------
// sku_custo_aquisicao (CRUD sob /skus/:skuId/custo-aquisicao e
// /custo-aquisicao/:id). SO para SKU comprado (400 no handler se fabricado).
// Historico de vigencia preservado; GET retorna o vigente (?historico=true
// retorna o historico). logSensitiveAction na escrita (dado de custo).
// ---------------------------------------------------------------------
export const custoAquisicaoCreateSchema = z
  .object({
    fornecedor: z.string({ invalid_type_error: "fornecedor deve ser string" }).trim().nullish(),
    custo: moneyField("custo"),
    vigencia_inicio: dateField("vigencia_inicio").optional(),
    vigencia_fim: dateField("vigencia_fim").nullish(),
  })
  .strict();

export type CustoAquisicaoCreateInput = z.infer<typeof custoAquisicaoCreateSchema>;

export const custoAquisicaoUpdateSchema = z
  .object({
    fornecedor: z.string({ invalid_type_error: "fornecedor deve ser string" }).trim().nullish(),
    custo: moneyField("custo").optional(),
    vigencia_inicio: dateField("vigencia_inicio").optional(),
    vigencia_fim: dateField("vigencia_fim").nullish(),
  })
  .strict();

export type CustoAquisicaoUpdateInput = z.infer<typeof custoAquisicaoUpdateSchema>;

// =====================================================================
// Dominio C (Produtos): Parametros escalares (3 niveis), vetor regional e
// indicadores de apoio dos precos calculados (secao 3.2 da SPEC). Payloads
// JSON em snake_case; .strict() rejeita chaves desconhecidas (400). valor e
// custo_base sao EXCLUSIVOS do motor (RF-23) e nunca entram nestes schemas.
// =====================================================================

/** Niveis de heranca dos parametros (resolucao PRODUTO -> LINHA -> GLOBAL). */
export const PARAMETRO_NIVEIS = ["global", "linha", "produto"] as const;
export type ParametroNivel = (typeof PARAMETRO_NIVEIS)[number];

export const parametroNivelEnum = z.enum(PARAMETRO_NIVEIS, {
  errorMap: () => ({ message: `nivel invalido (use: ${PARAMETRO_NIVEIS.join(", ")})` }),
});

/** Regioes do vetor regional (uma linha por regiao por escopo). */
export const REGIOES = ["S", "SE", "CO", "NE", "N"] as const;
export type Regiao = (typeof REGIOES)[number];

export const regiaoEnum = z.enum(REGIOES, {
  errorMap: () => ({ message: `regiao invalida (use: ${REGIOES.join(", ")})` }),
});

/**
 * Resolve/valida o parametro `nivel` de uma query string (GET). Ausente ->
 * undefined (sem filtro); valor presente e invalido -> 400.
 */
export function parseNivelFilter(value: string | null): ParametroNivel | undefined {
  if (value === null || value.trim() === "") return undefined;
  const result = parametroNivelEnum.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      400,
      "validation_error",
      `nivel invalido (use: ${PARAMETRO_NIVEIS.join(", ")})`,
    );
  }
  return result.data;
}

/** Campo de percentual/taxa escalar: numero finito, aceita null (limpa). */
const scalarField = (label: string) =>
  z
    .number({ invalid_type_error: `${label} deve ser numero` })
    .finite(`${label} deve ser finito`)
    .nullable()
    .optional();

/**
 * CHECK de coerencia nivel/escopo (espelha parametros_calculo_escopo_coerente_check):
 *   - global  -> escopo_id deve ser ausente/nulo
 *   - linha/produto -> escopo_id obrigatorio (UUID)
 * Aplicado via superRefine para virar 400 com mensagem util antes do DB.
 */
function refineEscopoCoerente(
  val: { nivel: ParametroNivel; escopo_id?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (val.nivel === "global" && val.escopo_id != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["escopo_id"],
      message: "escopo_id deve ser nulo quando nivel = global",
    });
  }
  if (val.nivel !== "global" && val.escopo_id == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["escopo_id"],
      message: "escopo_id e obrigatorio quando nivel = linha ou produto",
    });
  }
}

// ---------------------------------------------------------------------
// parametros_calculo (PUT /parametros). Upsert por (nivel, escopo_id) com
// merge parcial: apenas os campos informados sao gravados (preserva os
// demais). Os triggers da sprint 2 recalculam os SKUs do escopo (RF-15).
// ---------------------------------------------------------------------
export const parametrosUpsertSchema = z
  .object({
    nivel: parametroNivelEnum,
    escopo_id: z
      .string({ invalid_type_error: "escopo_id deve ser string" })
      .uuid("escopo_id deve ser UUID")
      .nullish(),
    impostos_pct: scalarField("impostos_pct"),
    frete_pct: scalarField("frete_pct"),
    despesas_pct: scalarField("despesas_pct"),
    lucro_pct: scalarField("lucro_pct"),
    lucro_minimo_pct: scalarField("lucro_minimo_pct"),
    taxa_horaria: scalarField("taxa_horaria"),
    horas_por_dia: scalarField("horas_por_dia"),
  })
  .strict()
  .superRefine(refineEscopoCoerente);

export type ParametrosUpsertInput = z.infer<typeof parametrosUpsertSchema>;

// ---------------------------------------------------------------------
// parametro_regional (PUT /parametros-regional). Vetor de 5 regioes com
// override PARCIAL: apenas as regioes informadas sao upsertadas por
// (nivel, escopo_id, regiao). Os triggers recalculam os SKUs do escopo.
// ---------------------------------------------------------------------
export const parametroRegionalItemSchema = z
  .object({
    regiao: regiaoEnum,
    // null = herdar do nivel acima (simetrico aos escalares; o handler grava
    // null e resolveRegiao trata null como heranca).
    percentual: z
      .number({
        required_error: "percentual e obrigatorio",
        invalid_type_error: "percentual deve ser numero",
      })
      .finite("percentual deve ser finito")
      .nullable(),
  })
  .strict();

export const parametroRegionalUpsertSchema = z
  .object({
    nivel: parametroNivelEnum,
    escopo_id: z
      .string({ invalid_type_error: "escopo_id deve ser string" })
      .uuid("escopo_id deve ser UUID")
      .nullish(),
    regioes: z
      .array(parametroRegionalItemSchema)
      .min(1, "regioes deve ter ao menos um item"),
  })
  .strict()
  .superRefine(refineEscopoCoerente);

export type ParametroRegionalUpsertInput = z.infer<typeof parametroRegionalUpsertSchema>;

// ---------------------------------------------------------------------
// sku_precos_calculados - indicadores de apoio (PUT /skus/:skuId/precos/apoio).
// Grava SOMENTE preco_concorrencia/custo_ideal; NUNCA valor/custo_base/ifp
// (exclusivos do motor, RF-23). Todos opcionais; null limpa o indicador.
// ---------------------------------------------------------------------
const apoioField = (label: string) =>
  z
    .number({ invalid_type_error: `${label} deve ser numero` })
    .finite(`${label} deve ser finito`)
    .nullable()
    .optional();

export const precoApoioSchema = z
  .object({
    preco_concorrencia: apoioField("preco_concorrencia"),
    custo_ideal: apoioField("custo_ideal"),
  })
  .strict();

export type PrecoApoioInput = z.infer<typeof precoApoioSchema>;

// ---------------------------------------------------------------------
// Schema: dados institucionais da empresa (PUT /config-empresa).
// Singleton config_empresa, usado no cabecalho/rodape da tabela de precos
// em PDF. Todos os campos opcionais (preenchimento incremental pelo
// cockpit). A logo e uma data URL base64 de imagem (sem bucket).
// ---------------------------------------------------------------------
const empresaTexto = (campo: string, max: number) =>
  z
    .string({ invalid_type_error: `${campo} deve ser string` })
    .trim()
    .max(max, `${campo} muito longo`)
    .nullish();

export const configEmpresaSchema = z
  .object({
    razaoSocial: empresaTexto("razaoSocial", 200),
    nomeFantasia: empresaTexto("nomeFantasia", 200),
    cnpj: empresaTexto("cnpj", 40),
    inscricaoEstadual: empresaTexto("inscricaoEstadual", 40),
    endereco: empresaTexto("endereco", 400),
    telefone: empresaTexto("telefone", 60),
    email: empresaTexto("email", 160),
    site: empresaTexto("site", 200),
    logoBase64: z
      .string({ invalid_type_error: "logoBase64 deve ser string" })
      .trim()
      .max(2_000_000, "logo muito grande (max ~1.5 MB)")
      .regex(
        /^data:image\/(png|jpe?g|svg\+xml|webp);base64,/,
        "logo deve ser uma data URL de imagem (png, jpeg, svg ou webp)",
      )
      .nullish(),
    validadePadraoDias: z
      .number({ invalid_type_error: "validadePadraoDias deve ser numero" })
      .int("validadePadraoDias deve ser inteiro")
      .min(0, "validadePadraoDias deve ser >= 0")
      .max(3650, "validadePadraoDias excede o teto (10 anos)")
      .nullish(),
    observacaoRodape: empresaTexto("observacaoRodape", 1000),
  })
  .strict();

export type ConfigEmpresaInput = z.infer<typeof configEmpresaSchema>;

// ---------------------------------------------------------------------
// Schema: config da IA/LLM (PUT /config-llm).
//   provider: allowlist (so 'openai' no MVP).
//   modelo:   nome do modelo, nao-vazio.
//   ativo:    liga/desliga a geracao assistida.
//   apiKey:   OPCIONAL — quando presente, vai CIFRADA p/ o Vault e nunca
//             volta ao cliente; ausente preserva a chave ja gravada.
// ---------------------------------------------------------------------
export const LLM_PROVIDERS = ["openai"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const configLlmSchema = z
  .object({
    provider: z.enum(LLM_PROVIDERS, {
      errorMap: () => ({ message: "provider invalido (use 'openai')" }),
    }),
    modelo: z
      .string({ required_error: "modelo e obrigatorio", invalid_type_error: "modelo deve ser string" })
      .trim()
      .min(1, "modelo nao pode ser vazio")
      .max(80, "modelo muito longo"),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }),
    descricaoMaxPalavras: z
      .number({
        required_error: "descricaoMaxPalavras e obrigatorio",
        invalid_type_error: "descricaoMaxPalavras deve ser numero",
      })
      .int("descricaoMaxPalavras deve ser inteiro")
      .min(10, "descricaoMaxPalavras deve ser >= 10")
      .max(300, "descricaoMaxPalavras excede o teto (300)"),
    apiKey: z
      .string({ invalid_type_error: "apiKey deve ser string" })
      .trim()
      .min(1, "apiKey nao pode ser vazia")
      .max(400, "apiKey muito longa")
      .optional(),
  })
  .strict();

export type ConfigLlmInput = z.infer<typeof configLlmSchema>;

// ---------------------------------------------------------------------
// config_busca — configuracao do RERANKING da busca semantica (singleton).
//   rerankAtivo:       master switch (OFF => Edge usa vetorial puro).
//   rerankModelo:      modelo Cohere (ex.: 'rerank-v3.5').
//   rerankCandidatos:  quantos chunks o vetorial traz antes do rerank [1,50].
//   hibridaAtiva:      master switch da fusao RRF (vetorial + lexical).
//   hibridaCandidatosLexical: quantos chunks a perna lexical traz p/ a fusao [1,50].
//   apiKey:            OPCIONAL — quando presente, vai CIFRADA p/ o Vault e
//                      nunca volta ao cliente; ausente preserva a ja gravada.
// ---------------------------------------------------------------------
// Allowlist de modelos Cohere de rerank suportados. Restringe a entrada a
// modelos validos (defesa em profundidade; o cockpit ja oferece um select).
export const RERANK_MODELOS = [
  "rerank-v3.5",
  "rerank-multilingual-v3.0",
  "rerank-english-v3.0",
] as const;

export const configBuscaSchema = z
  .object({
    rerankAtivo: z.boolean({ invalid_type_error: "rerankAtivo deve ser booleano" }),
    rerankModelo: z.enum(RERANK_MODELOS, {
      required_error: "rerankModelo e obrigatorio",
      invalid_type_error: "rerankModelo invalido",
    }),
    rerankCandidatos: z
      .number({
        required_error: "rerankCandidatos e obrigatorio",
        invalid_type_error: "rerankCandidatos deve ser numero",
      })
      .int("rerankCandidatos deve ser inteiro")
      .min(1, "rerankCandidatos deve ser >= 1")
      .max(50, "rerankCandidatos excede o teto (50)"),
    // Fusao hibrida (RRF). Defaults p/ compatibilidade com clientes antigos
    // que ainda nao enviam os campos (a perna hibrida nasce desligada).
    hibridaAtiva: z
      .boolean({ invalid_type_error: "hibridaAtiva deve ser booleano" })
      .default(false),
    hibridaCandidatosLexical: z
      .number({ invalid_type_error: "hibridaCandidatosLexical deve ser numero" })
      .int("hibridaCandidatosLexical deve ser inteiro")
      .min(1, "hibridaCandidatosLexical deve ser >= 1")
      .max(50, "hibridaCandidatosLexical excede o teto (50)")
      .default(50),
    apiKey: z
      .string({ invalid_type_error: "apiKey deve ser string" })
      .trim()
      .min(1, "apiKey nao pode ser vazia")
      .max(400, "apiKey muito longa")
      .optional(),
  })
  .strict();

export type ConfigBuscaInput = z.infer<typeof configBuscaSchema>;

/**
 * Valida dados ja desserializados (ex.: metadados de multipart/form-data) com
 * um schema zod. Espelha a semantica do parseJsonBody (400 validation_error
 * com mensagem util), para bordas que nao recebem JSON.
 */
export function parseWithSchema<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, "validation_error", formatZodError(result.error));
  }
  return result.data;
}

// =====================================================================
// Dominio A (Produtos): upload de imagens no Storage (secao 3.2 / RNF-14).
// Limites: 5MB por arquivo; MIME image/jpeg|png|webp; 10 fotos por Produto
// e 10 por SKU. signed URL de leitura com TTL de 1h. Os metadados do
// multipart sao validados por imagemUploadMetaSchema; o binario (tipo e
// tamanho) e validado no handler ANTES de qualquer escrita no Storage.
// =====================================================================

export const IMAGEM_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImagemMimeType = (typeof IMAGEM_MIME_TYPES)[number];

/** Extensao do objeto no Storage por MIME aceito. */
export const IMAGEM_EXTENSAO: Record<ImagemMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Tamanho maximo por arquivo: 5MB (RNF-14). */
export const IMAGEM_MAX_BYTES = 5 * 1024 * 1024;

/** Maximo de fotos por Produto e por SKU (excedente -> 400). */
export const IMAGEM_MAX_POR_ALVO = 10;

/** TTL da signed URL de leitura retornada no GET: 1 hora (3600s). */
export const IMAGEM_SIGNED_URL_TTL_SECONDS = 3600;

/** True quando o MIME informado e um tipo de imagem aceito. */
export function isImagemMimeAceito(mime: string | null | undefined): mime is ImagemMimeType {
  return typeof mime === "string" && (IMAGEM_MIME_TYPES as readonly string[]).includes(mime);
}

export const imagemUploadMetaSchema = z
  .object({
    produto_id: z
      .string({ invalid_type_error: "produto_id deve ser string" })
      .uuid("produto_id deve ser UUID")
      .optional(),
    sku_id: z
      .string({ invalid_type_error: "sku_id deve ser string" })
      .uuid("sku_id deve ser UUID")
      .optional(),
    ordem: z.coerce
      .number({ invalid_type_error: "ordem deve ser numero" })
      .int("ordem deve ser inteiro")
      .min(0, "ordem nao pode ser negativa")
      .optional(),
    legenda: z
      .string({ invalid_type_error: "legenda deve ser string" })
      .trim()
      .min(1, "legenda nao pode ser vazia")
      .optional(),
  })
  .strict()
  .refine((d) => d.produto_id !== undefined || d.sku_id !== undefined, {
    message: "informe ao menos um de produto_id ou sku_id",
  });

export type ImagemUploadMetaInput = z.infer<typeof imagemUploadMetaSchema>;

// =====================================================================
// Dominio D (Produtos): clientes de revenda + precos por cliente/SKU com
// historico de vigencia. Canal SEPARADO do de licitacao (RF-16/RF-17): a
// nova faixa de vigencia NUNCA sobrescreve a anterior (sem UNIQUE rigido).
// =====================================================================

export const clienteRevendaCreateSchema = z
  .object({
    nome: z
      .string({ required_error: "nome e obrigatorio", invalid_type_error: "nome deve ser string" })
      .trim()
      .min(1, "nome nao pode ser vazio"),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
  })
  .strict();

export type ClienteRevendaCreateInput = z.infer<typeof clienteRevendaCreateSchema>;

export const clienteRevendaUpdateSchema = z
  .object({
    nome: z
      .string({ invalid_type_error: "nome deve ser string" })
      .trim()
      .min(1, "nome nao pode ser vazio")
      .optional(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
  })
  .strict();

export type ClienteRevendaUpdateInput = z.infer<typeof clienteRevendaUpdateSchema>;

export const revendaPrecoCreateSchema = z
  .object({
    sku_id: z
      .string({
        required_error: "sku_id e obrigatorio",
        invalid_type_error: "sku_id deve ser string",
      })
      .uuid("sku_id deve ser UUID"),
    preco: moneyField("preco"),
    vigencia_inicio: dateField("vigencia_inicio").optional(),
    vigencia_fim: dateField("vigencia_fim").nullish(),
  })
  .strict();

export type RevendaPrecoCreateInput = z.infer<typeof revendaPrecoCreateSchema>;

export const revendaPrecoUpdateSchema = z
  .object({
    preco: moneyField("preco").optional(),
    vigencia_inicio: dateField("vigencia_inicio").optional(),
    vigencia_fim: dateField("vigencia_fim").nullish(),
  })
  .strict();

export type RevendaPrecoUpdateInput = z.infer<typeof revendaPrecoUpdateSchema>;

// =====================================================================
// Dominio E (Produtos): criterios de cotacao, regras estruturadas e
// politica de participacao (secao 3.2 / RF-18..RF-21B). Diferente dos
// parametros, o `nivel` aqui aceita 'linha', 'produto' ou 'sku' e
// `escopo_id` e SEMPRE obrigatorio (FK logica, not null no schema). O texto
// de cotacao_diretrizes.texto e politica_participacao.diretriz_texto e
// indexado em memoria_chunks (origem='produto', tipo='produto-cotacao').
// =====================================================================

/** Niveis de escopo de cotacao (precedencia PRODUTO sobre LINHA). */
export const COTACAO_NIVEIS = ["linha", "produto", "sku"] as const;
export type CotacaoNivel = (typeof COTACAO_NIVEIS)[number];

export const cotacaoNivelEnum = z.enum(COTACAO_NIVEIS, {
  errorMap: () => ({ message: `nivel invalido (use: ${COTACAO_NIVEIS.join(", ")})` }),
});

/**
 * Resolve/valida o filtro `nivel` (?nivel=) restrito a linha/produto/sku. Ausente
 * -> undefined (sem filtro); valor presente e invalido -> 400.
 */
export function parseCotacaoNivelFilter(value: string | null): CotacaoNivel | undefined {
  if (value === null || value.trim() === "") return undefined;
  const result = cotacaoNivelEnum.safeParse(value);
  if (!result.success) {
    throw new HttpError(
      400,
      "validation_error",
      `nivel invalido (use: ${COTACAO_NIVEIS.join(", ")})`,
    );
  }
  return result.data;
}

/** escopo_id obrigatorio (UUID, not null no schema de cotacao). */
const escopoIdRequired = z
  .string({
    required_error: "escopo_id e obrigatorio",
    invalid_type_error: "escopo_id deve ser string",
  })
  .uuid("escopo_id deve ser UUID");

/** escopo_id opcional (UUID) para updates parciais. */
const escopoIdOptional = z
  .string({ invalid_type_error: "escopo_id deve ser string" })
  .uuid("escopo_id deve ser UUID")
  .optional();

// ---------------------------------------------------------------------
// cotacao_diretrizes (CRUD /cotacao-diretrizes). texto e NOT NULL e e o
// conteudo indexavel: salvar texto nao-vazio reindexa; deletar remove.
// ---------------------------------------------------------------------
export const cotacaoDiretrizCreateSchema = z
  .object({
    nivel: cotacaoNivelEnum,
    escopo_id: escopoIdRequired,
    texto: z
      .string({
        required_error: "texto e obrigatorio",
        invalid_type_error: "texto deve ser string",
      })
      .trim()
      .min(1, "texto nao pode ser vazio"),
  })
  .strict();

export type CotacaoDiretrizCreateInput = z.infer<typeof cotacaoDiretrizCreateSchema>;

export const cotacaoDiretrizUpdateSchema = z
  .object({
    nivel: cotacaoNivelEnum.optional(),
    escopo_id: escopoIdOptional,
    texto: z
      .string({ invalid_type_error: "texto deve ser string" })
      .trim()
      .min(1, "texto nao pode ser vazio")
      .optional(),
  })
  .strict();

export type CotacaoDiretrizUpdateInput = z.infer<typeof cotacaoDiretrizUpdateSchema>;

// ---------------------------------------------------------------------
// cotacao_regras (CRUD /cotacao-regras). Regras estruturadas por atributo;
// valor_min > valor_max e rejeitado com 400 (espelha o CHECK do schema).
// ---------------------------------------------------------------------
export const COTACAO_TIPOS_REGRA = ["faixa", "opcional", "substituicao"] as const;
export type CotacaoTipoRegra = (typeof COTACAO_TIPOS_REGRA)[number];

export const cotacaoTipoRegraEnum = z.enum(COTACAO_TIPOS_REGRA, {
  errorMap: () => ({ message: `tipo_regra invalido (use: ${COTACAO_TIPOS_REGRA.join(", ")})` }),
});

/** Valor numerico finito de faixa; aceita null (limpa) e ausente. */
const regraValorField = (label: string) =>
  z
    .number({ invalid_type_error: `${label} deve ser numero` })
    .finite(`${label} deve ser finito`)
    .nullable()
    .optional();

export const cotacaoRegraCreateSchema = z
  .object({
    nivel: cotacaoNivelEnum,
    escopo_id: escopoIdRequired,
    atributo: z
      .string({
        required_error: "atributo e obrigatorio",
        invalid_type_error: "atributo deve ser string",
      })
      .trim()
      .min(1, "atributo nao pode ser vazio"),
    tipo_regra: cotacaoTipoRegraEnum,
    valor_min: regraValorField("valor_min"),
    valor_max: regraValorField("valor_max"),
    substituicao: z
      .string({ invalid_type_error: "substituicao deve ser string" })
      .trim()
      .min(1, "substituicao nao pode ser vazia")
      .nullish(),
  })
  .strict();

export type CotacaoRegraCreateInput = z.infer<typeof cotacaoRegraCreateSchema>;

export const cotacaoRegraUpdateSchema = z
  .object({
    nivel: cotacaoNivelEnum.optional(),
    escopo_id: escopoIdOptional,
    atributo: z
      .string({ invalid_type_error: "atributo deve ser string" })
      .trim()
      .min(1, "atributo nao pode ser vazio")
      .optional(),
    tipo_regra: cotacaoTipoRegraEnum.optional(),
    valor_min: regraValorField("valor_min"),
    valor_max: regraValorField("valor_max"),
    substituicao: z
      .string({ invalid_type_error: "substituicao deve ser string" })
      .trim()
      .min(1, "substituicao nao pode ser vazia")
      .nullish(),
  })
  .strict();

export type CotacaoRegraUpdateInput = z.infer<typeof cotacaoRegraUpdateSchema>;

// ---------------------------------------------------------------------
// politica_participacao (CRUD /politica-participacao). diretriz_texto e
// nullable e e o conteudo indexavel: salvar texto nao-vazio reindexa;
// deletar/esvaziar remove. participa restrito a sim/nao/condicional.
// ---------------------------------------------------------------------
export const POLITICA_PARTICIPA = ["sim", "nao", "condicional"] as const;
export type PoliticaParticipa = (typeof POLITICA_PARTICIPA)[number];

export const politicaParticipaEnum = z.enum(POLITICA_PARTICIPA, {
  errorMap: () => ({ message: `participa invalido (use: ${POLITICA_PARTICIPA.join(", ")})` }),
});

export const politicaParticipacaoCreateSchema = z
  .object({
    nivel: cotacaoNivelEnum,
    escopo_id: escopoIdRequired,
    participa: politicaParticipaEnum,
    condicao: z
      .string({ invalid_type_error: "condicao deve ser string" })
      .trim()
      .min(1, "condicao nao pode ser vazia")
      .nullish(),
    // diretriz_texto aceita string vazia/null (semantica de esvaziar -> remove
    // chunks); por isso nao aplica min(1).
    diretriz_texto: z
      .string({ invalid_type_error: "diretriz_texto deve ser string" })
      .nullish(),
    preferencia: z
      .string({ invalid_type_error: "preferencia deve ser string" })
      .trim()
      .min(1, "preferencia nao pode ser vazia")
      .nullish(),
  })
  .strict();

export type PoliticaParticipacaoCreateInput = z.infer<typeof politicaParticipacaoCreateSchema>;

export const politicaParticipacaoUpdateSchema = z
  .object({
    nivel: cotacaoNivelEnum.optional(),
    escopo_id: escopoIdOptional,
    participa: politicaParticipaEnum.optional(),
    condicao: z
      .string({ invalid_type_error: "condicao deve ser string" })
      .trim()
      .min(1, "condicao nao pode ser vazia")
      .nullish(),
    diretriz_texto: z
      .string({ invalid_type_error: "diretriz_texto deve ser string" })
      .nullish(),
    preferencia: z
      .string({ invalid_type_error: "preferencia deve ser string" })
      .trim()
      .min(1, "preferencia nao pode ser vazia")
      .nullish(),
  })
  .strict();

export type PoliticaParticipacaoUpdateInput = z.infer<typeof politicaParticipacaoUpdateSchema>;

// =====================================================================
// Dominio H (Documentos PDF - MVP, secao 3.2). Corpos dos 3 endpoints de
// geracao de PDF efemero (ficha tecnica, composicao de custos, lista de
// precos de licitacao). Validacao na borda ANTES de qualquer consulta.
// =====================================================================

/** POST /documentos/ficha-tecnica  { produto_id } */
export const fichaTecnicaSchema = z
  .object({
    produto_id: z
      .string({
        required_error: "produto_id e obrigatorio",
        invalid_type_error: "produto_id deve ser string",
      })
      .uuid("produto_id deve ser UUID"),
  })
  .strict();

export type FichaTecnicaInput = z.infer<typeof fichaTecnicaSchema>;

/** POST /documentos/composicao-custos  { sku_id } */
export const composicaoCustosSchema = z
  .object({
    sku_id: z
      .string({
        required_error: "sku_id e obrigatorio",
        invalid_type_error: "sku_id deve ser string",
      })
      .uuid("sku_id deve ser UUID"),
  })
  .strict();

export type ComposicaoCustosInput = z.infer<typeof composicaoCustosSchema>;

/** POST /documentos/lista-precos-licitacao  { sku_ids: [uuid] } */
export const listaPrecosLicitacaoSchema = z
  .object({
    sku_ids: z
      .array(
        z
          .string({ invalid_type_error: "sku_ids deve conter apenas strings" })
          .uuid("cada sku_id deve ser UUID"),
        { required_error: "sku_ids e obrigatorio", invalid_type_error: "sku_ids deve ser array" },
      )
      .min(1, "sku_ids deve ter ao menos um item")
      .max(200, "sku_ids deve ter no maximo 200 itens")
      .transform((items) => Array.from(new Set(items))),
  })
  .strict();

export type ListaPrecosLicitacaoInput = z.infer<typeof listaPrecosLicitacaoSchema>;

// ---------------------------------------------------------------------
// conhecimentos (CRUD). Base de conhecimento por setor, versionada e
// administrada no cockpit, entregue pela FILA ao subagente. POST exige
// setor/titulo/conteudo; PUT aceita campos parciais. Trigger versiona.
// ---------------------------------------------------------------------
export const MAX_CONHECIMENTO_TITULO_CHARS = 200;
export const MAX_CONHECIMENTO_CONTEUDO_CHARS = 50_000;
export const MAX_CONHECIMENTO_SETOR_CHARS = 80;

export const conhecimentoCreateSchema = z
  .object({
    setor: z
      .string({ required_error: "setor e obrigatorio", invalid_type_error: "setor deve ser string" })
      .trim()
      .min(1, "setor nao pode ser vazio")
      .max(MAX_CONHECIMENTO_SETOR_CHARS, "setor muito longo"),
    titulo: z
      .string({ required_error: "titulo e obrigatorio", invalid_type_error: "titulo deve ser string" })
      .trim()
      .min(1, "titulo nao pode ser vazio")
      .max(MAX_CONHECIMENTO_TITULO_CHARS, "titulo muito longo"),
    conteudo: z
      .string({ required_error: "conteudo e obrigatorio", invalid_type_error: "conteudo deve ser string" })
      .trim()
      .min(1, "conteudo nao pode ser vazio")
      .max(MAX_CONHECIMENTO_CONTEUDO_CHARS, "conteudo muito longo"),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
    ordem: z
      .number({ invalid_type_error: "ordem deve ser numero" })
      .int("ordem deve ser inteiro")
      .min(0, "ordem nao pode ser negativa")
      .optional(),
  })
  .strict();

export type ConhecimentoCreateInput = z.infer<typeof conhecimentoCreateSchema>;

export const conhecimentoUpdateSchema = z
  .object({
    setor: z
      .string({ invalid_type_error: "setor deve ser string" })
      .trim()
      .min(1, "setor nao pode ser vazio")
      .max(MAX_CONHECIMENTO_SETOR_CHARS, "setor muito longo")
      .optional(),
    titulo: z
      .string({ invalid_type_error: "titulo deve ser string" })
      .trim()
      .min(1, "titulo nao pode ser vazio")
      .max(MAX_CONHECIMENTO_TITULO_CHARS, "titulo muito longo")
      .optional(),
    conteudo: z
      .string({ invalid_type_error: "conteudo deve ser string" })
      .trim()
      .min(1, "conteudo nao pode ser vazio")
      .max(MAX_CONHECIMENTO_CONTEUDO_CHARS, "conteudo muito longo")
      .optional(),
    ativo: z.boolean({ invalid_type_error: "ativo deve ser booleano" }).optional(),
    ordem: z
      .number({ invalid_type_error: "ordem deve ser numero" })
      .int("ordem deve ser inteiro")
      .min(0, "ordem nao pode ser negativa")
      .optional(),
  })
  .strict();

export type ConhecimentoUpdateInput = z.infer<typeof conhecimentoUpdateSchema>;
