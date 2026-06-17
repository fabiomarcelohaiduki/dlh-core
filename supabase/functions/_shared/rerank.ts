// =====================================================================
// _shared/rerank.ts
// Camada de RERANKING da busca semantica (qualidade pos-vetorial).
//
//   A busca vetorial (HNSW cosine) compara EMBEDDINGS — boa em recall, fraca
//   em nuance e termos exatos (numero de edital, UASG, jargao). O reranker e
//   um modelo cross-encoder que le query + trecho JUNTOS e devolve um score
//   de relevancia real, reordenando o top-K vetorial. Ganho grande de
//   precisao por pouco esforco, sem tocar no indice nem na indexacao.
//
//   - CohereRerankProvider: chama a API gerenciada da Cohere (/v2/rerank),
//     com retry/backoff em 429/5xx e timeout por tentativa. A chave vem do
//     Vault (COHERE_RERANK_API_KEY), nunca de .env do cliente.
//   - loadConfigBusca(): le o singleton config_busca (master switch do rerank,
//     modelo, nº de candidatos) — administravel pelo cockpit, sem hardcode.
//   - resolveRerankProvider(): monta o provider lendo a chave do Vault.
//
//   FAIL-OPEN e responsabilidade do CHAMADOR (a Edge): se o rerank falhar
//   (chave ausente, Cohere fora, timeout), a busca devolve o top-N VETORIAL
//   em vez de quebrar. Rerank melhora a ordem; nunca derruba a busca.
// =====================================================================

import { createServiceClient } from "./supabase.ts";
import { HttpError } from "./http.ts";
import { getServiceSecret } from "./vault.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Nome deterministico do segredo da API key da Cohere no Vault. */
export const COHERE_RERANK_API_KEY_NAME = "COHERE_RERANK_API_KEY" as const;

const COHERE_DEFAULT_ENDPOINT = "https://api.cohere.com";
const COHERE_DEFAULT_MODEL = "rerank-v3.5";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Erro de rerank (causa conhecida: rede/credencial/resposta invalida). */
export class RerankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerankError";
  }
}

/** Falha transitoria (429/5xx/rede/timeout) que justifica retry com backoff. */
class RetryableRerankError extends RerankError {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableRerankError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Resultado por documento: indice de ENTRADA + score de relevancia [0,1]. */
export interface RerankResult {
  /** Indice do documento na lista ORIGINAL passada ao rerank. */
  index: number;
  /** Score de relevancia da Cohere (maior = mais relevante). */
  relevanceScore: number;
}

/** Contrato comum a qualquer provider de rerank (trocavel via config). */
export interface RerankProvider {
  readonly id: string;
  /**
   * Reordena `documents` por relevancia a `query` e devolve os top-N como
   * pares { index, relevanceScore } JA ordenados (mais relevante primeiro).
   * Lanca RerankError em falha (rede/credencial/resposta invalida).
   */
  rerank(
    query: string,
    documents: string[],
    topN: number,
    signal?: AbortSignal,
  ): Promise<RerankResult[]>;
}

/** Provider gerenciado: API de rerank da Cohere (/v2/rerank). */
export class CohereRerankProvider implements RerankProvider {
  public readonly id: string;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(config: {
    model: string;
    apiKey: string;
    endpoint?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseMs?: number;
  }) {
    if (!config.apiKey || config.apiKey.trim() === "") {
      throw new RerankError("chave da Cohere ausente (configure COHERE_RERANK_API_KEY no Vault)");
    }
    this.id = config.model || COHERE_DEFAULT_MODEL;
    this.apiKey = config.apiKey;
    this.endpoint = (config.endpoint ?? COHERE_DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, config.maxRetries ?? 3);
    this.retryBaseMs = Math.max(0, config.retryBaseMs ?? 400);
  }

  async rerank(
    query: string,
    documents: string[],
    topN: number,
    signal?: AbortSignal,
  ): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const n = Math.min(Math.max(1, Math.trunc(topN)), documents.length);

    let lastErr: RerankError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.rerankOnce(query, documents, n, signal);
      } catch (err) {
        if (!(err instanceof RetryableRerankError)) throw err;
        lastErr = err;
        if (attempt === this.maxRetries) break;
        if (signal?.aborted) throw new RerankError("rerank cancelado");
        const backoff = err.retryAfterMs ?? this.retryBaseMs * 2 ** attempt;
        await delay(backoff);
      }
    }
    throw lastErr ?? new RerankError("falha no rerank apos retries");
  }

  private async rerankOnce(
    query: string,
    documents: string[],
    topN: number,
    signal?: AbortSignal,
  ): Promise<RerankResult[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const res = await this.fetchImpl(`${this.endpoint}/v2/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.id,
          query,
          documents,
          top_n: topN,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          throw new RetryableRerankError(
            `Cohere respondeu ${res.status}`,
            parseRetryAfter(res.headers.get("retry-after")),
          );
        }
        throw new RerankError(`Cohere respondeu ${res.status}`);
      }

      const payload = (await res.json()) as unknown;
      return parseRerankResponse(payload, documents.length);
    } catch (err) {
      if (err instanceof RerankError) throw err;
      if (isAbortError(err)) {
        throw new RetryableRerankError("tempo de resposta excedido no rerank (timeout)");
      }
      throw new RetryableRerankError("falha de rede ao contatar a Cohere");
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

// ---------------------------------------------------------------------
// Config administravel (singleton config_busca)
// ---------------------------------------------------------------------

/** Parametros administraveis do rerank (singleton config_busca). */
export interface ConfigBusca {
  /** Master switch: OFF => Edge usa vetorial puro (nao chama Cohere). */
  rerankAtivo: boolean;
  /** Modelo Cohere (ex.: 'rerank-v3.5'). */
  rerankModelo: string;
  /** Quantos candidatos o vetorial traz antes do rerank (cap [1,50]). */
  rerankCandidatos: number;
  /** Master switch da fusao RRF (vetorial + lexical). OFF => vetorial puro. */
  hibridaAtiva: boolean;
  /** Quantos chunks a perna lexical traz para a fusao RRF (cap [1,50]). */
  hibridaCandidatosLexical: number;
}

/**
 * Le o singleton config_busca. Null SOMENTE quando nao ha linha (o chamador
 * trata como rerank desligado). Um erro REAL de banco propaga (HttpError 500)
 * em vez de virar "desligado" silencioso.
 */
export async function loadConfigBusca(service: ServiceClient): Promise<ConfigBusca | null> {
  const { data, error } = await service
    .from("config_busca")
    .select(
      "rerank_ativo, rerank_modelo, rerank_candidatos, hibrida_ativa, hibrida_candidatos_lexical",
    )
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_busca_erro", `falha ao ler config_busca: ${error.message}`);
  }
  if (!data) return null;
  const c = data as Record<string, unknown>;
  return {
    rerankAtivo: c.rerank_ativo === true,
    rerankModelo: typeof c.rerank_modelo === "string" && c.rerank_modelo.trim() !== ""
      ? c.rerank_modelo
      : COHERE_DEFAULT_MODEL,
    rerankCandidatos: typeof c.rerank_candidatos === "number" && c.rerank_candidatos > 0
      ? Math.min(c.rerank_candidatos, 50)
      : 50,
    hibridaAtiva: c.hibrida_ativa === true,
    hibridaCandidatosLexical:
      typeof c.hibrida_candidatos_lexical === "number" && c.hibrida_candidatos_lexical > 0
        ? Math.min(c.hibrida_candidatos_lexical, 50)
        : 50,
  };
}

/**
 * Monta o provider de rerank lendo a chave do Vault (COHERE_RERANK_API_KEY).
 * Sem a chave -> HttpError 503 (rerank requer credencial). O chamador faz
 * fail-open: captura e cai no vetorial puro.
 */
export async function resolveRerankProvider(modelo?: string): Promise<RerankProvider> {
  const apiKey = await getServiceSecret(COHERE_RERANK_API_KEY_NAME);
  if (!apiKey) {
    throw new HttpError(
      503,
      "rerank_key_ausente",
      "rerank requer COHERE_RERANK_API_KEY no Vault, ausente",
    );
  }
  return new CohereRerankProvider({ model: modelo ?? COHERE_DEFAULT_MODEL, apiKey });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Normaliza a resposta /v2/rerank: { results: [{ index, relevance_score }] }. */
function parseRerankResponse(payload: unknown, total: number): RerankResult[] {
  if (payload === null || typeof payload !== "object") {
    throw new RerankError("resposta de rerank invalida");
  }
  const results = (payload as Record<string, unknown>).results;
  if (!Array.isArray(results)) {
    throw new RerankError("formato de resposta de rerank nao reconhecido");
  }
  return results.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    const index = obj.index;
    const score = obj.relevance_score;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= total) {
      throw new RerankError("indice de rerank fora do intervalo");
    }
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new RerankError("relevance_score de rerank invalido");
    }
    return { index, relevanceScore: score };
  });
}

/** Converte o header Retry-After (segundos ou data HTTP) em ms, se valido. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "AbortError"
    : err instanceof Error && err.name === "AbortError";
}
