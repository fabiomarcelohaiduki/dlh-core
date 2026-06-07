// =====================================================================
// _shared/embeddings.ts
// Indexacao por embeddings com PROVIDER PLUGAVEL (US-08/US-18, RNF-04).
//
//   - Interface `EmbeddingProvider` trocavel via config (env). O padrao do
//     MVP e bge-m3 local self-hosted, gerando vector(1024) — ZERO custo por
//     token (nunca usa o modelo Claude na ingestao, RNF-04).
//   - `chunkText()` segmenta o conteudo verbatim para busca; o verbatim
//     integro permanece em avisos.conteudo_verbatim (nunca mutado aqui).
//   - `generateAndStoreChunks()` (re)indexa um aviso: apaga chunks antigos,
//     gera embeddings dos segmentos e grava em aviso_chunks (ordem, conteudo,
//     embedding) de forma idempotente (suporta reprocesso por item).
//
// Trocar o provider (ex.: API gerenciada) nao altera o schema: a dimensao e
// validada contra `EMBEDDINGS_DIM` (default 1024) e isolada em aviso_chunks.
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "./env.ts";

// ---------------------------------------------------------------------
// Contrato do provider plugavel
// ---------------------------------------------------------------------

/** Contrato comum a qualquer provider de embeddings (trocavel via config). */
export interface EmbeddingProvider {
  /** Identificador legivel do provider ativo (ex.: "bge-m3-local"). */
  readonly id: string;
  /** Dimensao dos vetores gerados (deve casar com a coluna vector(N)). */
  readonly dimensions: number;
  /**
   * Gera embeddings para um lote de textos. Mantem a ordem de entrada.
   * Lanca EmbeddingError em falha (rede/dimensao/resposta invalida).
   */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** Erro de geracao/validacao de embeddings (causa conhecida no pipeline). */
export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export interface EmbeddingProviderConfig {
  provider?: string;
  endpoint?: string;
  dimensions?: number;
  /** fetch injetavel para testabilidade. Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------
// Provider default: bge-m3 local self-hosted (sem custo por token)
// ---------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Provider que delega a um servico de embeddings self-hosted (bge-m3) via
 * HTTP. Zero custo por token: o modelo roda localmente, nunca o Claude.
 * Espera resposta { embedding: number[][] } | { embeddings: number[][] } |
 * { data: [{ embedding: number[] }] } (formato compativel OpenAI).
 */
export class LocalHttpEmbeddingProvider implements EmbeddingProvider {
  public readonly id: string;
  public readonly dimensions: number;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: {
    id: string;
    endpoint: string;
    dimensions: number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    if (!config.endpoint || config.endpoint.trim() === "") {
      throw new EmbeddingError(
        "endpoint de embeddings ausente (configure EMBEDDINGS_ENDPOINT)",
      );
    }
    this.id = config.id;
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.dimensions = config.dimensions;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const res = await this.fetchImpl(`${this.endpoint}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ model: this.id, input: texts }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new EmbeddingError(
          `servico de embeddings respondeu ${res.status}`,
        );
      }

      const payload = (await res.json()) as unknown;
      const vectors = parseEmbeddingResponse(payload);
      if (vectors.length !== texts.length) {
        throw new EmbeddingError(
          `quantidade de embeddings (${vectors.length}) difere dos textos (${texts.length})`,
        );
      }
      for (const vec of vectors) {
        if (vec.length !== this.dimensions) {
          throw new EmbeddingError(
            `dimensao inesperada: esperado ${this.dimensions}, recebido ${vec.length}`,
          );
        }
      }
      return vectors;
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      if (isAbortError(err)) {
        throw new EmbeddingError("tempo de resposta excedido ao gerar embeddings (timeout)");
      }
      throw new EmbeddingError("falha de rede ao contatar o servico de embeddings");
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * Resolve o provider de embeddings a partir da config (env por padrao).
 * Novos providers entram aqui sem alterar o schema nem o pipeline.
 */
export function createEmbeddingProvider(
  config: EmbeddingProviderConfig = {},
): EmbeddingProvider {
  const env = getEnv();
  const provider = config.provider ?? env.embeddingsProvider;
  const endpoint = config.endpoint ?? env.embeddingsEndpoint ?? "";
  const dimensions = config.dimensions ?? env.embeddingsDim;

  switch (provider) {
    // bge-m3 local e o default; outros providers self-hosted compativeis
    // (mesmo contrato HTTP) podem reutilizar a mesma implementacao.
    case "bge-m3-local":
    default:
      return new LocalHttpEmbeddingProvider({
        id: provider,
        endpoint,
        dimensions,
        fetchImpl: config.fetchImpl,
        timeoutMs: config.timeoutMs,
      });
  }
}

// ---------------------------------------------------------------------
// Chunking do conteudo verbatim
// ---------------------------------------------------------------------

export interface ChunkOptions {
  /** Tamanho maximo de cada chunk em caracteres. */
  maxChars?: number;
  /** Sobreposicao entre chunks consecutivos (preserva contexto na busca). */
  overlapChars?: number;
}

export interface TextChunk {
  ordem: number;
  conteudo: string;
}

const DEFAULT_MAX_CHARS = 2_000;
const DEFAULT_OVERLAP_CHARS = 200;

/**
 * Segmenta um texto em chunks ordenados com sobreposicao. Quebra
 * preferencialmente em fronteiras de paragrafo/sentenca para nao cortar
 * palavras. O texto de origem (verbatim) nunca e alterado.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const overlap = Math.min(
    Math.max(0, opts.overlapChars ?? DEFAULT_OVERLAP_CHARS),
    maxChars - 1,
  );

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized === "") return [];
  if (normalized.length <= maxChars) {
    return [{ ordem: 0, conteudo: normalized }];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let ordem = 0;

  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);

    if (end < normalized.length) {
      // Procura uma fronteira "natural" perto do fim do chunk.
      const slice = normalized.slice(start, end);
      const boundary = findBoundary(slice);
      if (boundary > 0) {
        end = start + boundary;
      }
    }

    const conteudo = normalized.slice(start, end).trim();
    if (conteudo !== "") {
      chunks.push({ ordem, conteudo });
      ordem += 1;
    }

    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

/** Maior fronteira (paragrafo > sentenca > espaco) dentro do slice. */
function findBoundary(slice: string): number {
  const minAccept = Math.floor(slice.length * 0.5);
  const candidates = [
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf("\n"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf(" "),
  ];
  for (const idx of candidates) {
    if (idx >= minAccept) return idx + 1;
  }
  return -1;
}

// ---------------------------------------------------------------------
// Indexacao: gera embeddings dos chunks e grava em aviso_chunks
// ---------------------------------------------------------------------

export interface IndexResult {
  chunks: number;
}

export interface IndexOptions {
  /** Lote de embeddings por requisicao ao provider. */
  embedBatchSize?: number;
  chunk?: ChunkOptions;
  signal?: AbortSignal;
}

/**
 * (Re)indexa o verbatim de um aviso de forma idempotente: remove chunks
 * antigos, gera embeddings dos novos segmentos e grava em aviso_chunks.
 * O `db` deve ser service_role (escrita server-side contornando RLS no
 * contexto do pipeline/reprocesso). Lanca EmbeddingError em falha.
 */
export async function generateAndStoreChunks(
  db: SupabaseClient,
  params: {
    avisoId: string;
    verbatim: string;
    provider: EmbeddingProvider;
  },
  options: IndexOptions = {},
): Promise<IndexResult> {
  const batchSize = Math.max(1, options.embedBatchSize ?? 32);
  const chunks = chunkText(params.verbatim, options.chunk);

  // Reprocesso idempotente: limpa chunks anteriores antes de reescrever.
  const { error: delError } = await db
    .from("aviso_chunks")
    .delete()
    .eq("aviso_id", params.avisoId);
  if (delError) {
    throw new EmbeddingError(`falha ao limpar chunks anteriores: ${delError.message}`);
  }

  if (chunks.length === 0) return { chunks: 0 };

  const rows: Array<{
    aviso_id: string;
    ordem: number;
    conteudo: string;
    embedding: string;
  }> = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (options.signal?.aborted) {
      throw new EmbeddingError("indexacao cancelada");
    }
    const slice = chunks.slice(i, i + batchSize);
    const vectors = await params.provider.embed(
      slice.map((c) => c.conteudo),
      options.signal,
    );
    slice.forEach((chunk, idx) => {
      rows.push({
        aviso_id: params.avisoId,
        ordem: chunk.ordem,
        conteudo: chunk.conteudo,
        // pgvector aceita o literal textual "[v1,v2,...]" via PostgREST.
        embedding: toVectorLiteral(vectors[idx]),
      });
    });
  }

  const { error: insError } = await db.from("aviso_chunks").insert(rows);
  if (insError) {
    throw new EmbeddingError(`falha ao gravar chunks: ${insError.message}`);
  }

  return { chunks: rows.length };
}

/**
 * (Re)indexa um registro generico no indice de memoria AGNOSTICO de origem
 * (memoria_chunks, DD-01), de forma idempotente: limpa os chunks anteriores
 * do registro (origem + registro_id), segmenta o verbatim, gera embeddings
 * e grava com origem/tipo/registro_id/chunk_index. Reaproveita o MESMO
 * chunkText/provider do aviso (bge-m3, vector(1024)) sem tocar aviso_chunks.
 *
 * `db` deve ser service_role (escrita server-side contornando RLS no contexto
 * da ingestao - SEC-05). Lanca EmbeddingError em falha.
 */
export async function generateAndStoreMemoriaChunks(
  db: SupabaseClient,
  params: {
    origem: string;
    tipo: string | null;
    registroId: string;
    verbatim: string;
    provider: EmbeddingProvider;
  },
  options: IndexOptions = {},
): Promise<IndexResult> {
  const batchSize = Math.max(1, options.embedBatchSize ?? 32);
  const chunks = chunkText(params.verbatim, options.chunk);

  // Reindexacao idempotente: limpa os chunks do registro (origem+registro_id)
  // ANTES de regravar, para nunca acumular versoes antigas (RF-19/US-10).
  const { error: delError } = await db
    .from("memoria_chunks")
    .delete()
    .eq("origem", params.origem)
    .eq("registro_id", params.registroId);
  if (delError) {
    throw new EmbeddingError(`falha ao limpar chunks de memoria anteriores: ${delError.message}`);
  }

  if (chunks.length === 0) return { chunks: 0 };

  const rows: Array<{
    origem: string;
    tipo: string | null;
    registro_id: string;
    chunk_index: number;
    verbatim: string;
    embedding: string;
  }> = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (options.signal?.aborted) {
      throw new EmbeddingError("indexacao cancelada");
    }
    const slice = chunks.slice(i, i + batchSize);
    const vectors = await params.provider.embed(
      slice.map((c) => c.conteudo),
      options.signal,
    );
    slice.forEach((chunk, idx) => {
      rows.push({
        origem: params.origem,
        tipo: params.tipo,
        registro_id: params.registroId,
        chunk_index: chunk.ordem,
        verbatim: chunk.conteudo,
        embedding: toVectorLiteral(vectors[idx]),
      });
    });
  }

  const { error: insError } = await db.from("memoria_chunks").insert(rows);
  if (insError) {
    throw new EmbeddingError(`falha ao gravar chunks de memoria: ${insError.message}`);
  }

  return { chunks: rows.length };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Formata um vetor numerico no literal aceito pelo tipo vector do pgvector. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** Normaliza diferentes formatos de resposta de servicos de embeddings. */
function parseEmbeddingResponse(payload: unknown): number[][] {
  if (payload === null || typeof payload !== "object") {
    throw new EmbeddingError("resposta de embeddings invalida");
  }
  const obj = payload as Record<string, unknown>;

  // Formato compativel OpenAI: { data: [{ embedding: number[] }] }
  if (Array.isArray(obj.data)) {
    return obj.data.map((item) => {
      const emb = (item as Record<string, unknown>)?.embedding;
      return asNumberArray(emb);
    });
  }

  const direct = obj.embeddings ?? obj.embedding;
  if (Array.isArray(direct)) {
    // Pode ser number[][] (lote) ou number[] (singular).
    if (direct.length > 0 && Array.isArray(direct[0])) {
      return (direct as unknown[]).map(asNumberArray);
    }
    return [asNumberArray(direct)];
  }

  throw new EmbeddingError("formato de resposta de embeddings nao reconhecido");
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new EmbeddingError("embedding nao e um array numerico");
  }
  const out = value.map((n) => {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new EmbeddingError("embedding contem valor nao numerico");
    }
    return n;
  });
  return out;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "AbortError"
    : err instanceof Error && err.name === "AbortError";
}
