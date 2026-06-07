// =====================================================================
// _shared/nomus-connector.ts
// Conector Nomus (ERP) reutilizavel (US-06/US-07/US-08/US-12, RF-10..RF-14).
//
// Reaproveita o PADRAO arquitetural do Effecti (SourceConnector, fetch com
// backoff, parseRetryAfter, computeBackoff) SEM reusar o codigo literal nem o
// tipo CollectedAviso (RNF-17). Produz `CollectedRecord` (contrato proprio).
//
// Caracteristicas:
//   - UMA instancia, UMA chave de integracao no Vault, que retorna as DUAS
//     empresas (famaha/darlu) via o campo `empresa` de cada processo (US-08).
//   - Auth `Authorization: Basic <chave>` + `Content-Type: application/json`.
//     A chave e injetada em runtime (lida do Vault pela borda) e o header
//     Basic NUNCA e logado (SEC-01).
//   - Paginacao `GET /rest/processos?pagina=N` a partir de 1; resposta tratada
//     como ARRAY; pagina vazia encerra a varredura (RF-10).
//   - Throttling/retry (RF-13/RNF-06): 429 respeita Retry-After; 5xx ->
//     backoff exponencial limitado; 401 -> nao re-tenta (unauthorized);
//     lotes de NOMUS_TAMANHO_LOTE chamadas com pausa NOMUS_PAUSA_LOTE_MS.
//   - Janela incremental (DD-02): caminho primario via filtro server-side
//     `?query=campoData>...`; fallback por re-scan de etapas nao terminais.
//
// Escopo negativo: campos personalizados (write-only na API), anexos e
// escrita de volta estao FORA de escopo (RF-18).
// =====================================================================

import {
  type CollectOptions,
  ConnectionTestError,
  type ConnectionTestResult,
  type ConnectorConfig,
  type SourceConnector,
} from "./effecti-connector.ts";
import { type CollectedRecord } from "./collected.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Defaults de throttling/retry (SPEC 5.3). Configuraveis por env, sem
// alterar a logica. Valores numericos sao saneados (positivos inteiros).
// ---------------------------------------------------------------------

const ENV_DEFAULTS = {
  tamanhoLote: 14, // NOMUS_TAMANHO_LOTE
  pausaLoteMs: 5_000, // NOMUS_PAUSA_LOTE_MS
  timeoutMs: 30_000, // NOMUS_TIMEOUT_MS
  maxRetries: 5, // NOMUS_MAX_RETRIES
  backoffTetoMs: 60_000, // NOMUS_BACKOFF_TETO_MS
  baseDelayMs: 500,
  janelaDias: 7,
} as const;

/** Le um inteiro positivo de env; usa fallback quando ausente/invalido. */
function envInt(name: string, fallback: number): number {
  let raw: string | undefined;
  try {
    raw = Deno.env.get(name);
  } catch {
    // Ambiente sem permissao de env (ex.: teste): cai no default.
    return fallback;
  }
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// ---------------------------------------------------------------------
// Configuracao do conector e do recurso (config_ingestao.recursos.<recurso>)
// ---------------------------------------------------------------------

/** Subconjunto de config_ingestao.recursos.<recurso> usado pelo conector. */
export interface NomusRecursoConfig {
  /** Recurso habilitado para coleta. */
  ativo?: boolean;
  /** Allowlist de tipos a ingerir (filtro aplicado no pipeline). */
  tipos_ativos?: string[];
  /** DD-02: quando true usa filtro server-side por data de alteracao. */
  usa_filtro_data_alteracao?: boolean;
  /** DD-02 (fallback): etapas consideradas TERMINAIS (sem re-scan). */
  etapas_terminais?: string[];
}

/** Resultado de uma pagina coletada (processamento em blocos com checkpoint). */
export interface NomusPage {
  /** Registros da pagina ja filtrados pela janela (DD-02). */
  records: CollectedRecord[];
  /** true quando a pagina nao retornou itens (fim da varredura). */
  vazia: boolean;
}

export interface NomusConnectorConfig extends ConnectorConfig {
  /** Config do recurso coletado (recursos.<recurso>) de config_ingestao. */
  recursoConfig?: NomusRecursoConfig;
  /** Nome do recurso (ex.: 'processos'). Default 'processos'. */
  recurso?: string;
  /** Janela movel em dias (US-12). Default 7. */
  janelaDias?: number;
  /** Nome do campo de data de ALTERACAO no filtro server-side (DD-02). */
  campoDataAlteracao?: string;
  /** Chamadas por lote antes da pausa (NOMUS_TAMANHO_LOTE, default 14). */
  tamanhoLote?: number;
  /** Pausa entre lotes em ms (NOMUS_PAUSA_LOTE_MS, default 5000). */
  pausaLoteMs?: number;
  /** Teto do backoff em ms (NOMUS_BACKOFF_TETO_MS, default 60000). */
  backoffTetoMs?: number;
}

// ---------------------------------------------------------------------
// NomusConnector
// ---------------------------------------------------------------------

export class NomusConnector implements SourceConnector<CollectedRecord> {
  public readonly tipo = "nomus";

  private readonly endpointBase: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly backoffTetoMs: number;
  private readonly tamanhoLote: number;
  private readonly pausaLoteMs: number;
  private readonly janelaDias: number;
  private readonly campoDataAlteracao: string;
  private readonly recursoConfig: NomusRecursoConfig;

  constructor(config: NomusConnectorConfig) {
    if (!config.endpointBase || config.endpointBase.trim() === "") {
      throw new Error("NomusConnector: endpointBase obrigatorio");
    }
    if (!config.token || config.token.trim() === "") {
      throw new Error("NomusConnector: chave obrigatoria (lida do Vault em runtime)");
    }
    this.endpointBase = config.endpointBase.replace(/\/+$/, "");
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? envInt("NOMUS_TIMEOUT_MS", ENV_DEFAULTS.timeoutMs);
    this.maxRetries = config.maxRetries ?? envInt("NOMUS_MAX_RETRIES", ENV_DEFAULTS.maxRetries);
    this.baseDelayMs = config.baseDelayMs ?? ENV_DEFAULTS.baseDelayMs;
    this.backoffTetoMs = config.backoffTetoMs ?? config.maxDelayMs ??
      envInt("NOMUS_BACKOFF_TETO_MS", ENV_DEFAULTS.backoffTetoMs);
    this.tamanhoLote = config.tamanhoLote ?? envInt("NOMUS_TAMANHO_LOTE", ENV_DEFAULTS.tamanhoLote);
    this.pausaLoteMs = config.pausaLoteMs ??
      envInt("NOMUS_PAUSA_LOTE_MS", ENV_DEFAULTS.pausaLoteMs);
    this.janelaDias = config.janelaDias && config.janelaDias > 0
      ? config.janelaDias
      : ENV_DEFAULTS.janelaDias;
    this.campoDataAlteracao = config.campoDataAlteracao ?? "dataAlteracao";
    this.recursoConfig = config.recursoConfig ?? {};
  }

  /**
   * Teste de conexao leve: GET /rest/processos?pagina=1. Classifica a causa
   * (unauthorized/rate_limited/timeout/unknown) para mensagem na borda. Nunca
   * loga o header Basic.
   */
  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
      const url = this.buildPageUrl(1, null);
      const res = await this.fetchWithBackoff(url, signal);
      const latenciaMs = Date.now() - startedAt;
      if (!res.ok) {
        throw new ConnectionTestError("unknown", `resposta inesperada (${res.status})`, latenciaMs);
      }
      return { estadoConexao: "conectada", latenciaMs };
    } catch (err) {
      const latenciaMs = Date.now() - startedAt;
      if (err instanceof ConnectionTestError) {
        throw new ConnectionTestError(err.failureCause, err.message, latenciaMs);
      }
      throw new ConnectionTestError("unknown", "falha inesperada ao testar a conexao", latenciaMs);
    }
  }

  /**
   * Coleta paginada de processos (RF-10). A partir de pagina=1, trata cada
   * resposta como ARRAY e encerra quando a pagina vem vazia. Aplica o controle
   * de throttling por lote (NOMUS_TAMANHO_LOTE/NOMUS_PAUSA_LOTE_MS).
   *
   * Janela incremental (DD-02), governada por `recursoConfig`:
   *   - usa_filtro_data_alteracao=true: filtro server-side
   *     `?query=<campoData>>yyyy-mm-ddTHH:mm:ss` sobre a data de alteracao;
   *     todos os itens retornados sao emitidos.
   *   - false (default): sem filtro server-side; emite os processos que estao
   *     DENTRO da janela de novos (data_criacao >= sinceDate) OU cuja `etapa`
   *     NAO e terminal (allowlist em etapas_terminais), fazendo o re-scan.
   */
  async *collect(options: CollectOptions): AsyncGenerator<CollectedRecord, void, unknown> {
    const since = options.sinceDate ?? new Date(Date.now() - this.janelaDias * MS_PER_DAY);
    const usaFiltroData = this.recursoConfig.usa_filtro_data_alteracao === true;
    const etapasTerminais = new Set(
      (this.recursoConfig.etapas_terminais ?? []).map(normalizeEtapa),
    );

    let pagina = 1;
    let chamadasNoLote = 0;

    while (true) {
      if (options.signal?.aborted) return;

      const url = this.buildPageUrl(pagina, usaFiltroData ? since : null);
      const res = await this.fetchWithBackoff(url, options.signal);
      const payload = (await res.json()) as unknown;

      // Contrato Nomus: a resposta de /rest/processos e um ARRAY (RF-10).
      const lista = Array.isArray(payload) ? payload : [];
      if (lista.length === 0) break; // pagina vazia encerra a varredura.

      for (const raw of lista) {
        const record = mapRawProcesso(raw);
        if (!record) continue;

        if (usaFiltroData) {
          // Filtro server-side ja restringiu por data de alteracao.
          yield record;
          continue;
        }

        // Fallback (DD-02): janela de novos OU etapa nao terminal (re-scan).
        const dentroJanela = isWithinWindow(record.data_criacao, since);
        const etapaNaoTerminal = !etapasTerminais.has(normalizeEtapa(record.etapa ?? ""));
        if (dentroJanela || etapaNaoTerminal) yield record;
      }

      pagina += 1;
      chamadasNoLote += 1;

      // Throttling por lote: apos NOMUS_TAMANHO_LOTE chamadas, pausa.
      if (chamadasNoLote >= this.tamanhoLote) {
        chamadasNoLote = 0;
        await delay(this.pausaLoteMs);
      }
    }
  }

  /**
   * Coleta UMA pagina especifica (RF-20). Habilita o processamento em BLOCOS
   * com checkpoint/retomada: o pipeline avanca pagina a pagina a partir de
   * `checkpoint.pagina_atual`, sem materializar todo o gerador. Aplica o mesmo
   * filtro de janela do `collect` (DD-02): com filtro server-side emite tudo;
   * sem filtro, mantem novos (data_criacao >= since) OU etapa nao terminal.
   *
   * `vazia=true` indica fim da varredura (pagina sem itens) — o orquestrador
   * usa esse sinal para concluir a execucao.
   */
  async collectPage(pagina: number, options: CollectOptions): Promise<NomusPage> {
    const since = options.sinceDate ?? new Date(Date.now() - this.janelaDias * MS_PER_DAY);
    const usaFiltroData = this.recursoConfig.usa_filtro_data_alteracao === true;
    const etapasTerminais = new Set(
      (this.recursoConfig.etapas_terminais ?? []).map(normalizeEtapa),
    );

    const url = this.buildPageUrl(pagina, usaFiltroData ? since : null);
    const res = await this.fetchWithBackoff(url, options.signal);
    const payload = (await res.json()) as unknown;

    const lista = Array.isArray(payload) ? payload : [];
    const records: CollectedRecord[] = [];

    for (const raw of lista) {
      const record = mapRawProcesso(raw);
      if (!record) continue;

      if (usaFiltroData) {
        records.push(record);
        continue;
      }

      const dentroJanela = isWithinWindow(record.data_criacao, since);
      const etapaNaoTerminal = !etapasTerminais.has(normalizeEtapa(record.etapa ?? ""));
      if (dentroJanela || etapaNaoTerminal) records.push(record);
    }

    return { records, vazia: lista.length === 0 };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private buildPageUrl(pagina: number, since: Date | null): string {
    const url = new URL(`${this.endpointBase}/rest/processos`);
    url.searchParams.set("pagina", String(pagina));
    if (since) {
      // DD-02 (caminho primario): filtro por data de alteracao server-side.
      url.searchParams.set("query", `${this.campoDataAlteracao}>${formatNomusDate(since)}`);
    }
    return url.toString();
  }

  /**
   * Requisicao GET com timeout + backoff (RNF-06/RF-13).
   * - 401 -> ConnectionTestError("unauthorized") SEM retry.
   * - 429 -> aguarda Retry-After (parseRetryAfter) e re-tenta; esgotado
   *   -> "rate_limited".
   * - 5xx -> backoff exponencial limitado por backoffTetoMs; esgotado
   *   -> "unknown".
   * - AbortError de timeout -> retry; esgotado -> "timeout".
   *
   * O header `Authorization: Basic` NUNCA e logado (SEC-01).
   */
  private async fetchWithBackoff(url: string, externalSignal?: AbortSignal): Promise<Response> {
    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      const onExternalAbort = () => controller.abort();
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

      try {
        const res = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            Authorization: `Basic ${this.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (res.status === 401) {
          throw new ConnectionTestError("unauthorized", "credencial Nomus invalida (401)", 0);
        }

        if (res.status === 429) {
          if (attempt >= this.maxRetries) {
            throw new ConnectionTestError(
              "rate_limited",
              "limite de requisicoes atingido (429)",
              0,
            );
          }
          // 429: aguarda o tempo ate liberar (Retry-After) e re-tenta.
          const tempoAteLiberar = parseRetryAfter(res.headers.get("Retry-After"));
          await delay(tempoAteLiberar ?? this.computeBackoff(attempt));
          attempt += 1;
          continue;
        }

        if (res.status >= 500) {
          if (attempt >= this.maxRetries) {
            throw new ConnectionTestError("unknown", `erro do servico Nomus (${res.status})`, 0);
          }
          await delay(this.computeBackoff(attempt));
          attempt += 1;
          continue;
        }

        if (!res.ok) {
          // 4xx nao retriable (exceto 401/429 tratados acima).
          throw new ConnectionTestError("unknown", `requisicao Nomus rejeitada (${res.status})`, 0);
        }

        // Rate limit do Nomus tambem chega no CORPO ({tempoAteLiberar:<seg>}),
        // por vezes com status 200. Sem isto, o objeto nao-array seria lido
        // como "pagina vazia" e a coleta encerraria incompleta (RF-13).
        const tempoCorpoMs = await peekTempoAteLiberar(res);
        if (tempoCorpoMs !== null) {
          if (attempt >= this.maxRetries) {
            throw new ConnectionTestError(
              "rate_limited",
              "limite de requisicoes atingido (tempoAteLiberar)",
              0,
            );
          }
          await delay(tempoCorpoMs + 1_000);
          attempt += 1;
          continue;
        }

        return res;
      } catch (err) {
        if (isAbortError(err)) {
          if (externalSignal?.aborted) {
            throw new ConnectionTestError("timeout", "coleta cancelada", 0);
          }
          if (attempt >= this.maxRetries) {
            throw new ConnectionTestError("timeout", "tempo de resposta excedido (timeout)", 0);
          }
          await delay(this.computeBackoff(attempt));
          attempt += 1;
          continue;
        }
        if (err instanceof ConnectionTestError) throw err;
        // Erro de rede (DNS/conexao): re-tenta com backoff ate esgotar.
        if (attempt >= this.maxRetries) {
          throw new ConnectionTestError("unknown", "falha de rede ao contatar o Nomus", 0);
        }
        await delay(this.computeBackoff(attempt));
        attempt += 1;
      } finally {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /** Backoff exponencial com jitter, limitado por backoffTetoMs (RF-13). */
  private computeBackoff(attempt: number): number {
    const exp = this.baseDelayMs * 2 ** attempt;
    const capped = Math.min(exp, this.backoffTetoMs);
    const jitter = Math.random() * (capped * 0.2);
    return Math.floor(capped + jitter);
  }
}

// ---------------------------------------------------------------------
// Mapeamento do payload bruto -> CollectedRecord (contrato proprio, RF-12)
// ---------------------------------------------------------------------

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = asString(obj[key]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Extrai um nome legivel de um campo que pode vir como string ou como objeto
 * (ex.: empresa/pessoa/reportador/responsavel embarcados). Retorna null
 * quando nao ha representacao textual util.
 */
function extractNome(value: unknown): string | null {
  const direct = asString(value);
  if (direct !== null) return direct;
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    return firstString(o, ["nome", "razaoSocial", "nomeFantasia", "descricao"]);
  }
  return null;
}

/**
 * Normaliza um processo bruto em CollectedRecord. Contrato real confirmado
 * (2026-06-07): o processo expoe APENAS id, tipo, etapa, nome, pessoa,
 * reportador, responsavel e dataCriacao (DD/MM/YYYY, sem hora). NAO existem
 * `dataAlteracao`, `empresa` nem `descricao` — os fallbacks restantes ficam por
 * robustez, mas resolvem null na pratica (empresa e derivada do tipo). Descarta
 * itens sem `id` (sem chave de dedup). `payload_bruto` preserva o bruto integral.
 */
export function mapRawProcesso(raw: unknown): CollectedRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const nomusId = firstString(obj, ["id", "nomus_id", "codigo"]);
  if (!nomusId) return null;

  const tipo = firstString(obj, ["tipo"]);

  return {
    nomus_id: nomusId,
    tipo,
    etapa: firstString(obj, ["etapa"]),
    // A API nao expoe campo `empresa`: a instancia E a Famaha e "Darlu"
    // aparece apenas como TIPO (ex.: "Cobranca DARLU"). Derivamos do tipo.
    empresa: deriveEmpresa(tipo),
    pessoa: extractNome(obj["pessoa"]),
    nome: firstString(obj, ["nome"]),
    reportador: extractNome(obj["reportador"]),
    responsavel: extractNome(obj["responsavel"]),
    descricao: firstString(obj, ["descricao"]),
    data_criacao: toIso(
      firstString(obj, [
        "data_criacao",
        "dataCriacao",
        "dataInclusao",
        "dataCadastro",
        "dataInicial",
        "criadoEm",
      ]),
    ),
    data_alteracao: toIso(
      firstString(obj, [
        "data_alteracao",
        "dataAlteracao",
        "dataUltimaAlteracao",
        "dataModificacao",
        "dataFinal",
        "alteradoEm",
        "atualizadoEm",
      ]),
    ),
    payload_bruto: raw,
  };
}

/**
 * Deriva a empresa a partir do `tipo` do processo. A API nao tem campo
 * empresa: a instancia E a Famaha e processos da Darlu vem com "DARLU" no tipo
 * (ex.: "Cobranca DARLU"). Retorna null quando nao ha tipo.
 */
function deriveEmpresa(tipo: string | null): string | null {
  if (!tipo) return null;
  return /darlu/i.test(tipo) ? "Darlu" : "Famaha";
}

// ---------------------------------------------------------------------
// Helpers de data / janela
// ---------------------------------------------------------------------

/** Formata uma data para o filtro Nomus: YYYY-MM-DDTHH:MM:SS (sem timezone). */
function formatNomusDate(d: Date): string {
  return d.toISOString().slice(0, 19);
}

/**
 * Converte data BR "DD/MM/YYYY[ HH:MM:SS]" ou ISO em ISO-8601 (offset BR
 * -03:00 quando vier no formato BR). Retorna null quando nao reconhece.
 */
function toIso(value: string | null): string | null {
  if (!value) return null;
  const m = value.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (m) {
    const [, dd, mm, yyyy, HH = "00", MI = "00", SS = "00"] = m;
    return `${yyyy}-${mm}-${dd}T${HH}:${MI}:${SS}-03:00`;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** true quando `iso` (data de criacao) cai dentro da janela [since, agora]. */
function isWithinWindow(iso: string | null, since: Date): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= since.getTime();
}

/** Normaliza etapa para comparacao case/space-insensitive com a allowlist. */
function normalizeEtapa(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------
// Utilitarios de rede (mesmo PADRAO do Effecti; implementacao propria)
// ---------------------------------------------------------------------

/**
 * Detecta o sinal de rate limit do Nomus no CORPO da resposta: um objeto JSON
 * { tempoAteLiberar: <segundos> }, que pode vir ate com status 200. Inspeciona
 * um clone para nao consumir o corpo original. Retorna o tempo em ms a aguardar
 * ou null quando o corpo nao e esse sinal (ex.: o array normal de processos).
 */
async function peekTempoAteLiberar(res: Response): Promise<number | null> {
  let text: string;
  try {
    text = await res.clone().text();
  } catch {
    return null;
  }
  if (!text.includes("tempoAteLiberar")) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const t = Number((parsed as Record<string, unknown>).tempoAteLiberar);
      if (Number.isFinite(t) && t >= 0) return Math.floor(t * 1000);
    }
  } catch {
    // corpo nao-JSON: nao e o sinal estruturado de rate limit.
  }
  return null;
}

/** Interpreta o header Retry-After (segundos ou data HTTP) em ms. */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "AbortError"
    : err instanceof Error && err.name === "AbortError";
}
