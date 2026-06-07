// =====================================================================
// _shared/effecti-connector.ts
// Conector Effecti reutilizavel (US-02/US-05, RF-03, RNF-10).
//
// Responsabilidades:
//   - Paginacao da API Effecti + backoff exponencial em rate limit/429
//     (e 5xx transitorio), respeitando Retry-After (RNF-10).
//   - Sync incremental pela data de captura dentro da janela configurada,
//     com dedupe por effecti_id (upsert on conflict).
//   - Teste de conexao com causas distintas: timeout, 401 (credencial
//     invalida) e 429 (rate limit).
//
// Desacoplamento (RF-11/RNF-15): a interface `SourceConnector` nao conhece
// `fontes.tipo`. `createConnector(tipo, ...)` resolve a implementacao; novos
// conectores entram sem refatorar o Effecti. No MVP apenas Effecti ativo.
//
// A credencial e SEMPRE injetada em runtime (lida do Vault pela borda),
// nunca de .env em producao (RNF-02).
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { type CollectedRecord } from "./collected.ts";
import { NomusConnector, type NomusConnectorConfig } from "./nomus-connector.ts";

// ---------------------------------------------------------------------
// Tipos publicos do conector
// ---------------------------------------------------------------------

export type EstadoConexao = "conectada" | "erro" | "nao_configurada";

/** Causa especifica de falha do teste de conexao (mensagem por causa). */
export type TestFailureCause = "timeout" | "unauthorized" | "rate_limited" | "unknown";

export interface ConnectionTestResult {
  estadoConexao: EstadoConexao;
  latenciaMs: number;
}

/** Erro de teste de conexao com causa classificada para mensagem na borda. */
export class ConnectionTestError extends Error {
  constructor(
    public readonly failureCause: TestFailureCause,
    message: string,
    public readonly latenciaMs: number,
  ) {
    super(message);
    this.name = "ConnectionTestError";
  }
}

/** Aviso coletado, ja normalizado para o substrato (camelCase no conector). */
export interface CollectedAviso {
  effectiId: string;
  modalidade: string;
  orgao: string;
  objeto: string;
  portal: string | null;
  conteudoVerbatim: string;
  payloadBruto: unknown;
  dataCaptura: string; // ISO-8601
  dataPublicacao: string | null;
  dataInicial: string | null;
  dataFinal: string | null;
  origem: string | null;
}

export interface CollectOptions {
  /** Limite inferior da janela (begin). API Effecti exige begin E end. */
  sinceDate: Date;
  /** Limite superior da janela (end). Default: agora. Janela max: 5 dias. */
  untilDate?: Date;
  /** Filtros (US-20). A API Effecti so aceita {begin,end}; os filtros sao
   *  aplicados no cliente. Ambos sao allowlists por igualdade de texto: lista
   *  vazia/ausente => sem filtro (ingere todos). `modalidades` casa com o campo
   *  `modalidade` da API; `portais` com o campo `portal`. */
  modalidades?: string[];
  portais?: string[];
  /** Tamanho de pagina (a API Effecti fixa em 100/pagina; ignorado). */
  pageSize?: number;
  /** Cancelamento externo (ex.: timeout global da coleta). */
  signal?: AbortSignal;
}

/** Janela maxima permitida pela API Effecti por consulta. */
const MAX_WINDOW_DAYS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Formata uma data para o body da API (YYYY-MM-DDTHH:MM:SS, sem timezone). */
function buildWindowBody(begin: Date, end: Date): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 19);
  return JSON.stringify({ begin: fmt(begin), end: fmt(end) });
}

/**
 * Converte data BR "DD/MM/YYYY HH:MM:SS" (formato real da API Effecti) em
 * ISO-8601 com offset BR (-03:00), aceitavel por colunas timestamptz.
 * Aceita tambem datas ja em ISO. Retorna null quando nao reconhece.
 */
function brToIso(value: string | null): string | null {
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

/**
 * Contrato comum a qualquer fonte; desacoplado de `fontes.tipo`.
 *
 * Parametrizado pelo tipo de registro coletado (`TRecord`). O default e
 * `CollectedAviso` (Effecti), preservando o contrato existente sem alteracao;
 * novos conectores (ex.: Nomus) instanciam com seu proprio tipo de registro
 * (`SourceConnector<CollectedRecord>`).
 */
export interface SourceConnector<TRecord = CollectedAviso> {
  readonly tipo: string;
  /** Testa a credencial/endpoint. Lanca ConnectionTestError em falha. */
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>;
  /** Gera registros pagina a pagina, filtrando incrementalmente pela janela. */
  collect(options: CollectOptions): AsyncGenerator<TRecord, void, unknown>;
}

// ---------------------------------------------------------------------
// Configuracao de rede / retry
// ---------------------------------------------------------------------

export interface ConnectorConfig {
  endpointBase: string;
  token: string;
  /** Implementacao de fetch injetavel (testabilidade). Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Timeout por requisicao (ms). */
  timeoutMs?: number;
  /** Numero maximo de re-tentativas em 429/5xx. */
  maxRetries?: number;
  /** Atraso base do backoff exponencial (ms). */
  baseDelayMs?: number;
  /** Teto do atraso do backoff (ms). */
  maxDelayMs?: number;
  /** Tamanho de pagina padrao. */
  defaultPageSize?: number;
}

const DEFAULTS = {
  timeoutMs: 15_000,
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  defaultPageSize: 100,
} as const;

// ---------------------------------------------------------------------
// EffectiConnector
// ---------------------------------------------------------------------

interface EffectiPage {
  items: CollectedAviso[];
  /** true quando ha mais paginas a buscar. */
  hasMore: boolean;
}

export class EffectiConnector implements SourceConnector {
  public readonly tipo = "effecti";

  private readonly endpointBase: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly defaultPageSize: number;

  constructor(config: ConnectorConfig) {
    if (!config.endpointBase || config.endpointBase.trim() === "") {
      throw new Error("EffectiConnector: endpointBase obrigatorio");
    }
    if (!config.token || config.token.trim() === "") {
      throw new Error("EffectiConnector: token obrigatorio (lido do Vault em runtime)");
    }
    this.endpointBase = config.endpointBase.replace(/\/+$/, "");
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxRetries = config.maxRetries ?? DEFAULTS.maxRetries;
    this.baseDelayMs = config.baseDelayMs ?? DEFAULTS.baseDelayMs;
    this.maxDelayMs = config.maxDelayMs ?? DEFAULTS.maxDelayMs;
    this.defaultPageSize = config.defaultPageSize ?? DEFAULTS.defaultPageSize;
  }

  /**
   * Testa a conexao com uma requisicao leve (primeira pagina, pageSize=1).
   * Classifica a causa da falha para mensagem especifica na borda.
   */
  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
      const end = new Date();
      const begin = new Date(end.getTime() - MS_PER_DAY);
      // Paginacao 0-indexed: a primeira pagina e page=0 (page=1 pode vir vazia).
      const url = this.buildPageUrl(0);
      const res = await this.fetchWithBackoff(
        url,
        { method: "POST", body: buildWindowBody(begin, end) },
        signal,
      );
      const latenciaMs = Date.now() - startedAt;
      // fetchWithBackoff so retorna respostas "ok" (2xx); demais viram erro.
      if (!res.ok) {
        throw new ConnectionTestError("unknown", `resposta inesperada (${res.status})`, latenciaMs);
      }
      return { estadoConexao: "conectada", latenciaMs };
    } catch (err) {
      const latenciaMs = Date.now() - startedAt;
      if (err instanceof ConnectionTestError) {
        // Preserva a causa mas garante latencia coerente com o teste atual.
        throw new ConnectionTestError(err.failureCause, err.message, latenciaMs);
      }
      throw new ConnectionTestError("unknown", "falha inesperada ao testar a conexao", latenciaMs);
    }
  }

  /**
   * Coleta paginada com sync incremental. A API Effecti limita cada consulta a
   * 5 dias: janelas maiores sao divididas em BLOCOS sequenciais de 5 dias e
   * todos sao iterados (nao se descarta o excedente). Dentro de cada bloco,
   * pagina 0-indexed ate esgotar. Filtra por portais e modalidades quando a
   * lista vier preenchida (allowlists do que a DLH realmente opera).
   */
  async *collect(options: CollectOptions): AsyncGenerator<CollectedAviso, void, unknown> {
    const end = options.untilDate ?? new Date();
    const overallBegin = options.sinceDate;

    // Filtro de portais (US-20): aplicado no cliente (a API so aceita begin/end).
    // Lista vazia/ausente => sem filtro (ingere todos os portais).
    const portaisFilter = options.portais && options.portais.length > 0
      ? new Set(options.portais)
      : null;

    // Filtro de modalidades: mesma logica de allowlist do cliente. O `value`
    // casa por igualdade com o campo `modalidade` retornado pela API (texto,
    // ex.: "Pregão Eletrônico", "Dispensa"). Lista vazia/ausente => todas.
    const modalidadesFilter = options.modalidades && options.modalidades.length > 0
      ? new Set(options.modalidades)
      : null;

    // Divide [overallBegin, end] em blocos de no maximo 5 dias (limite da API).
    let chunkBegin = overallBegin;
    while (chunkBegin.getTime() < end.getTime()) {
      if (options.signal?.aborted) return;

      const chunkEnd = new Date(
        Math.min(chunkBegin.getTime() + MAX_WINDOW_DAYS * MS_PER_DAY, end.getTime()),
      );

      // Paginacao 0-indexed: a primeira pagina e page=0 (page=1 pularia os
      // primeiros 100 registros, ou todos quando ha uma unica pagina).
      let page = 0;
      while (true) {
        if (options.signal?.aborted) return;

        const url = this.buildPageUrl(page);
        const res = await this.fetchWithBackoff(
          url,
          { method: "POST", body: buildWindowBody(chunkBegin, chunkEnd) },
          options.signal,
        );
        const payload = (await res.json()) as unknown;
        const { items, hasMore } = parseEffectiPage(payload);

        for (const item of items) {
          if (portaisFilter && (item.portal === null || !portaisFilter.has(item.portal))) {
            continue;
          }
          if (modalidadesFilter && !modalidadesFilter.has(item.modalidade)) {
            continue;
          }
          yield item;
        }

        if (items.length === 0 || !hasMore) break;
        page += 1;
      }

      // Proximo bloco comeca 1s apos o fim do anterior (evita sobreposicao).
      chunkBegin = new Date(chunkEnd.getTime() + 1000);
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private buildPageUrl(page: number): string {
    const url = new URL(`${this.endpointBase}/aviso/licitacao`);
    url.searchParams.set("page", String(page));
    return url.toString();
  }

  /**
   * Requisicao com timeout + backoff exponencial (RNF-10).
   * - 401 -> ConnectionTestError("unauthorized") (sem retry).
   * - 429 -> backoff respeitando Retry-After; esgotado -> "rate_limited".
   * - 5xx -> backoff transitorio; esgotado -> "unknown".
   * - AbortError de timeout -> retry; esgotado -> "timeout".
   */
  private async fetchWithBackoff(
    url: string,
    init: { method: string; body?: string },
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      const onExternalAbort = () => controller.abort();
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

      try {
        const res = await this.fetchImpl(url, {
          method: init.method,
          headers: {
            // API Effecti usa apiKey no header Authorization com o TOKEN CRU
            // (sem prefixo 'Bearer'). Confirmado via swagger + chamada real.
            Authorization: this.token,
            Accept: "application/json",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
          body: init.body,
          signal: controller.signal,
        });

        if (res.status === 401) {
          throw new ConnectionTestError("unauthorized", "credencial invalida (401)", 0);
        }

        if (res.status === 429 || res.status >= 500) {
          if (attempt >= this.maxRetries) {
            const cause: TestFailureCause = res.status === 429 ? "rate_limited" : "unknown";
            const msg = res.status === 429
              ? "limite de requisicoes atingido (429)"
              : `erro do servico Effecti (${res.status})`;
            throw new ConnectionTestError(cause, msg, 0);
          }
          const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
          await delay(retryAfter ?? this.computeBackoff(attempt));
          attempt += 1;
          continue;
        }

        if (!res.ok) {
          // 4xx nao retriable (exceto 401/429 tratados acima).
          throw new ConnectionTestError("unknown", `requisicao rejeitada (${res.status})`, 0);
        }

        return res;
      } catch (err) {
        // Timeout / cancelamento manifesta-se como AbortError.
        if (isAbortError(err)) {
          if (externalSignal?.aborted) {
            // Cancelamento externo: nao re-tenta.
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
          throw new ConnectionTestError("unknown", "falha de rede ao contatar o Effecti", 0);
        }
        await delay(this.computeBackoff(attempt));
        attempt += 1;
      } finally {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /** Backoff exponencial com jitter, limitado por maxDelayMs. */
  private computeBackoff(attempt: number): number {
    const exp = this.baseDelayMs * 2 ** attempt;
    const capped = Math.min(exp, this.maxDelayMs);
    const jitter = Math.random() * (capped * 0.2);
    return Math.floor(capped + jitter);
  }
}

// ---------------------------------------------------------------------
// Factory desacoplada de fontes.tipo (RF-11/RNF-15)
// ---------------------------------------------------------------------

/**
 * Resolve a implementacao de conector pelo tipo da fonte. Novos conectores
 * entram aqui sem alterar os existentes (RF-11/RNF-17). O caso 'effecti'
 * permanece inalterado; 'nomus' retorna o NomusConnector (CollectedRecord).
 *
 * Overloads preservam a tipagem por caso: `createConnector('nomus', cfg)`
 * (literal) entrega `SourceConnector<CollectedRecord>`; chamadas com `tipo`
 * generico (string) continuam entregando `SourceConnector` (CollectedAviso),
 * sem quebrar os callers do Effecti.
 */
export function createConnector(
  tipo: "nomus",
  config: NomusConnectorConfig,
): SourceConnector<CollectedRecord>;
export function createConnector(
  tipo: string,
  config: ConnectorConfig,
): SourceConnector;
export function createConnector(
  tipo: string,
  config: ConnectorConfig | NomusConnectorConfig,
): SourceConnector<CollectedAviso> | SourceConnector<CollectedRecord> {
  switch (tipo) {
    case "effecti":
      return new EffectiConnector(config);
    case "nomus":
      return new NomusConnector(config as NomusConnectorConfig);
    default:
      throw new Error(`conector nao suportado para o tipo de fonte: '${tipo}'`);
  }
}

// ---------------------------------------------------------------------
// Sync incremental + dedupe (upsert por effecti_id) — reutilizavel
// ---------------------------------------------------------------------

export interface SyncResult {
  total: number;
  novos: number;
  alterados: number;
}

export interface SyncOptions extends CollectOptions {
  /** Tamanho do lote de upsert (default 200). */
  batchSize?: number;
}

interface AvisoUpsertRow {
  effecti_id: string;
  modalidade: string;
  orgao: string;
  objeto: string;
  portal: string | null;
  conteudo_verbatim: string;
  payload_bruto: unknown;
  data_captura: string;
  data_publicacao: string | null;
  data_inicial: string | null;
  data_final: string | null;
  origem: string | null;
  execucao_origem_id: string | null;
}

/**
 * Executa o sync incremental consumindo um conector e persistindo no
 * substrato com dedupe por effecti_id (upsert on conflict). Reutilizavel
 * por qualquer SourceConnector. Retorna contagens novos/alterados/total.
 *
 * O cliente deve ser service_role (escrita em avisos contornando RLS no
 * contexto do job de coleta).
 */
export async function runIncrementalSync(
  connector: SourceConnector,
  db: SupabaseClient,
  options: SyncOptions & { execucaoId?: string | null },
): Promise<SyncResult> {
  const batchSize = options.batchSize ?? 200;
  const result: SyncResult = { total: 0, novos: 0, alterados: 0 };

  let batch: CollectedAviso[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const counts = await upsertBatch(db, batch, options.execucaoId ?? null);
    result.total += counts.total;
    result.novos += counts.novos;
    result.alterados += counts.alterados;
    batch = [];
  };

  for await (const aviso of connector.collect(options)) {
    batch.push(aviso);
    if (batch.length >= batchSize) {
      await flush();
    }
  }
  await flush();

  return result;
}

/**
 * Upsert de um lote com dedupe por effecti_id. Determina novos vs alterados
 * consultando os effecti_id ja existentes antes da escrita.
 */
async function upsertBatch(
  db: SupabaseClient,
  items: CollectedAviso[],
  execucaoId: string | null,
): Promise<SyncResult> {
  // Dedupe dentro do proprio lote (ultima ocorrencia vence).
  const dedup = new Map<string, CollectedAviso>();
  for (const item of items) dedup.set(item.effectiId, item);
  const unique = Array.from(dedup.values());
  const ids = unique.map((i) => i.effectiId);

  const { data: existing, error: selError } = await db
    .from("avisos")
    .select("effecti_id")
    .in("effecti_id", ids);

  if (selError) {
    throw new Error(`falha ao consultar avisos existentes: ${selError.message}`);
  }
  const existingSet = new Set<string>((existing ?? []).map((r) => String(r.effecti_id)));

  const rows: AvisoUpsertRow[] = unique.map((i) => ({
    effecti_id: i.effectiId,
    modalidade: i.modalidade,
    orgao: i.orgao,
    objeto: i.objeto,
    portal: i.portal,
    conteudo_verbatim: i.conteudoVerbatim,
    payload_bruto: i.payloadBruto,
    data_captura: i.dataCaptura,
    data_publicacao: i.dataPublicacao,
    data_inicial: i.dataInicial,
    data_final: i.dataFinal,
    origem: i.origem,
    execucao_origem_id: execucaoId,
  }));

  const { error: upError } = await db
    .from("avisos")
    .upsert(rows, { onConflict: "effecti_id", ignoreDuplicates: false });

  if (upError) {
    throw new Error(`falha ao fazer upsert de avisos: ${upError.message}`);
  }

  const alterados = unique.filter((i) => existingSet.has(i.effectiId)).length;
  return {
    total: unique.length,
    novos: unique.length - alterados,
    alterados,
  };
}

// ---------------------------------------------------------------------
// Parsing defensivo da resposta da API Effecti
// ---------------------------------------------------------------------

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
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
 * Normaliza um item bruto da API em CollectedAviso, com fallbacks de nomes
 * de campo. Itens sem effecti_id ou sem data de captura sao descartados
 * (nao ha chave de dedupe / posicao na janela).
 */
function mapRawAviso(raw: unknown): CollectedAviso | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  // id real do aviso na API Effecti = idLicitacao (numero).
  const effectiId = firstString(obj, ["effecti_id", "effectiId", "idLicitacao", "id", "codigo"]);
  const dataCaptura = brToIso(
    firstString(obj, ["data_captura", "dataCaptura", "capturadoEm", "capturedAt"]),
  );
  if (!effectiId || !dataCaptura) return null;

  return {
    effectiId,
    modalidade: firstString(obj, ["modalidade", "modality"]) ?? "desconhecida",
    orgao: firstString(obj, ["orgao", "organ", "orgaoNome", "unidadeGestora"]) ?? "desconhecido",
    objeto: firstString(obj, ["objeto", "objetoSemTags", "object", "descricao"]) ?? "",
    portal: firstString(obj, ["portal", "portalOrigem"]),
    conteudoVerbatim:
      firstString(obj, [
        "conteudo_verbatim",
        "conteudoVerbatim",
        "conteudo",
        "content",
        "objetoSemTags",
        "objeto",
      ]) ?? JSON.stringify(raw),
    payloadBruto: raw,
    dataCaptura,
    dataPublicacao: brToIso(
      firstString(obj, ["data_publicacao", "dataPublicacao", "publishedAt"]),
    ),
    dataInicial: brToIso(
      firstString(obj, ["data_inicial", "dataInicial", "dataInicialProposta", "startDate"]),
    ),
    dataFinal: brToIso(
      firstString(obj, ["data_final", "dataFinal", "dataFinalProposta", "endDate"]),
    ),
    origem: firstString(obj, ["origem", "source", "portal"]),
  };
}

function parseEffectiPage(payload: unknown): EffectiPage {
  if (typeof payload !== "object" || payload === null) {
    return { items: [], hasMore: false };
  }
  const obj = payload as Record<string, unknown>;

  // API Effecti real retorna a lista em `licitacoes`; demais sao fallback.
  const rawList = Array.isArray(payload)
    ? payload
    : (obj.licitacoes ?? obj.data ?? obj.items ?? obj.results ?? obj.avisos);
  const list = Array.isArray(rawList) ? rawList : [];

  const items = list
    .map(mapRawAviso)
    .filter((i): i is CollectedAviso => i !== null);

  const hasMore = computeHasMore(obj, list.length);
  return { items, hasMore };
}

/** Deriva hasMore de metadados de paginacao (varios formatos) ou heuristica. */
function computeHasMore(obj: Record<string, unknown>, pageItemCount: number): boolean {
  // API Effecti real expoe paginacao em `_metadata` (pagina_atual/total_paginas).
  const pagination = (obj._metadata ?? obj.pagination ?? obj.meta ?? obj) as Record<
    string,
    unknown
  >;

  const hasNextRaw = pagination["hasNext"] ?? pagination["has_more"] ?? pagination["hasMore"];
  if (typeof hasNextRaw === "boolean") return hasNextRaw;

  const page = toNumber(
    pagination["pagina_atual"] ?? pagination["page"] ?? pagination["currentPage"],
  );
  const totalPages = toNumber(
    pagination["total_paginas"] ?? pagination["totalPages"] ?? pagination["total_pages"],
  );
  if (page !== null && totalPages !== null) return page < totalPages;

  const pageSize = toNumber(
    pagination["pageSize"] ?? pagination["per_page"] ?? pagination["limit"],
  );
  // Sem metadados confiaveis: assume mais paginas enquanto a pagina vier cheia.
  if (pageSize !== null) return pageItemCount >= pageSize;
  return false;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
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
