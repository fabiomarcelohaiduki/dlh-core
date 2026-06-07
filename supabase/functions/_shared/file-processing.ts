// =====================================================================
// _shared/file-processing.ts
// Tratamento de arquivos de edital (US-19, RF-33, RF-36, RNF-05).
//
// Fluxo por arquivo (a partir do link no payload do aviso):
//   1. Download do binario por link (links Effecti podem expirar; por isso o
//      binario e PRESERVADO no Storage privado para recuperabilidade).
//   2. Upload em bucket privado do Supabase Storage -> aviso_arquivos.storage_path.
//   3. Extracao de texto VERBATIM por tipo (PDF nativo, DOC/DOCX, ZIP/RAR);
//      OCR APENAS como fallback quando nao ha camada de texto.
//   4. Grava aviso_arquivos.texto_extraido integro + status_tratamento
//      (ok | erro | nao_suportado).
//
// Extensao nao suportada ou falha gera erro VISIVEL em erros_ingestao sem
// travar o lote (RNF-05): cada arquivo e isolado em try/catch.
//
// O motor de extracao/OCR e PLUGAVEL (servico self-hosted via HTTP), mantendo
// a Edge Function leve e o engine (Tika/unstructured/tesseract) trocavel.
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "./env.ts";
import { errorMessage, recordIngestErro } from "./ingest-errors.ts";

// ---------------------------------------------------------------------
// Tipos publicos
// ---------------------------------------------------------------------

export type StatusTratamento = "ok" | "erro" | "nao_suportado";

/** Arquivo candidato extraido do payload do aviso. */
export interface FileToProcess {
  url: string;
  nomeArquivo: string | null;
}

export interface FileProcessingSummary {
  total: number;
  ok: number;
  erro: number;
  naoSuportado: number;
}

/** Extensoes com camada de texto extraivel diretamente (sem OCR). */
const NATIVE_TEXT_EXTENSIONS = new Set(["pdf", "doc", "docx", "txt", "rtf", "odt"]);
/** Arquivos compactados: descompactados pelo servico de extracao. */
const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z"]);
/** Extensoes elegiveis a OCR como fallback (sem camada de texto). */
const OCR_ELIGIBLE_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "tif", "tiff"]);

const SUPPORTED_EXTENSIONS = new Set<string>([
  ...NATIVE_TEXT_EXTENSIONS,
  ...ARCHIVE_EXTENSIONS,
]);

const DOWNLOAD_TIMEOUT_MS = 60_000;
const EXTRACTION_TIMEOUT_MS = 120_000;
/** Limite defensivo de tamanho de download (evita OOM na Edge Function). */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------
// Erros tipados do tratamento (causa conhecida)
// ---------------------------------------------------------------------

export class UnsupportedFileError extends Error {
  constructor(public readonly extensao: string) {
    super(`extensao nao suportada: ${extensao || "(desconhecida)"}`);
    this.name = "UnsupportedFileError";
  }
}

export class FileDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileDownloadError";
  }
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

// ---------------------------------------------------------------------
// Extrator de texto plugavel
// ---------------------------------------------------------------------

export interface ExtractionInput {
  bytes: Uint8Array;
  extension: string;
  nomeArquivo: string | null;
  signal?: AbortSignal;
}

export interface ExtractionResult {
  texto: string;
  /** true quando o texto veio do fallback OCR (sem camada de texto nativa). */
  usouOcr: boolean;
}

/** Contrato do motor de extracao (engine trocavel via config). */
export interface TextExtractor {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

/**
 * Extrator que delega a um servico self-hosted via HTTP. Tenta a extracao
 * NATIVA primeiro; se o tipo for elegivel a OCR e nao houver camada de texto
 * (texto vazio), refaz em modo OCR como FALLBACK (RF-33).
 */
export class ServiceTextExtractor implements TextExtractor {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: {
    endpoint: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    if (!config.endpoint || config.endpoint.trim() === "") {
      throw new ExtractionError(
        "servico de extracao nao configurado (defina FILE_EXTRACTION_ENDPOINT)",
      );
    }
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? EXTRACTION_TIMEOUT_MS;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const native = await this.callService(input, "native");
    if (native.trim() !== "") {
      return { texto: native, usouOcr: false };
    }

    // Sem camada de texto: tenta OCR como fallback quando aplicavel.
    if (OCR_ELIGIBLE_EXTENSIONS.has(input.extension)) {
      const ocr = await this.callService(input, "ocr");
      return { texto: ocr, usouOcr: true };
    }

    // Tipos de arquivo (ex.: docx vazio) sem texto e sem OCR aplicavel.
    return { texto: native, usouOcr: false };
  }

  private async callService(
    input: ExtractionInput,
    mode: "native" | "ocr",
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const form = new FormData();
      form.append("mode", mode);
      form.append("extension", input.extension);
      if (input.nomeArquivo) form.append("filename", input.nomeArquivo);
      form.append(
        "file",
        new Blob([toArrayBuffer(input.bytes)]),
        input.nomeArquivo ?? `arquivo.${input.extension}`,
      );

      const res = await this.fetchImpl(`${this.endpoint}/extract`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new ExtractionError(
          `servico de extracao respondeu ${res.status} (modo ${mode})`,
        );
      }

      const payload = (await res.json()) as unknown;
      return parseExtractionText(payload);
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      if (isAbortError(err)) {
        throw new ExtractionError(`tempo de extracao excedido (modo ${mode})`);
      }
      throw new ExtractionError(
        `falha ao contatar o servico de extracao (modo ${mode}): ${errorMessage(err)}`,
      );
    } finally {
      clearTimeout(timeoutId);
      input.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

/** Resolve o extrator a partir da config (servico self-hosted por padrao). */
export function createTextExtractor(config: {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): TextExtractor {
  const endpoint = config.endpoint ?? getEnv().fileExtractionEndpoint ?? "";
  return new ServiceTextExtractor({
    endpoint,
    fetchImpl: config.fetchImpl,
    timeoutMs: config.timeoutMs,
  });
}

// ---------------------------------------------------------------------
// Orquestracao do tratamento de arquivos de um aviso
// ---------------------------------------------------------------------

export interface ProcessFilesParams {
  avisoId: string;
  execucaoId?: string | null;
  files: FileToProcess[];
  extractor: TextExtractor;
  /** Cliente service_role (escrita em aviso_arquivos/Storage server-side). */
  fetchImpl?: typeof fetch;
  bucket?: string;
  signal?: AbortSignal;
}

/**
 * Processa todos os arquivos de um aviso. Cada arquivo e ISOLADO: falha de um
 * vira status_tratamento + erros_ingestao e NAO interrompe os demais (RNF-05).
 */
export async function processAvisoFiles(
  db: SupabaseClient,
  params: ProcessFilesParams,
): Promise<FileProcessingSummary> {
  const env = getEnv();
  const bucket = params.bucket ?? env.editaisBucket;
  const fetchImpl = params.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const summary: FileProcessingSummary = { total: 0, ok: 0, erro: 0, naoSuportado: 0 };

  for (const file of params.files) {
    if (params.signal?.aborted) break;
    summary.total += 1;
    const extension = resolveExtension(file);

    try {
      // Extensao nao suportada: registra antes de qualquer download.
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        throw new UnsupportedFileError(extension);
      }

      const { bytes, contentType } = await downloadBinary(
        fetchImpl,
        file.url,
        params.signal,
      );

      // Preserva o binario no Storage privado (recuperabilidade - RF-33).
      const storagePath = buildStoragePath(params.avisoId, extension);
      const { error: upError } = await db.storage
        .from(bucket)
        .upload(storagePath, bytes, {
          contentType: contentType ?? "application/octet-stream",
          upsert: true,
        });
      if (upError) {
        throw new FileDownloadError(`falha ao salvar binario no Storage: ${upError.message}`);
      }

      // Linha base do arquivo (status definitivo apos a extracao).
      const arquivoId = await upsertArquivoRow(db, {
        avisoId: params.avisoId,
        nomeArquivo: file.nomeArquivo,
        extensao: extension,
        tamanhoBytes: bytes.byteLength,
        storagePath,
      });

      // Extracao verbatim por tipo (OCR so como fallback).
      const result = await params.extractor.extract({
        bytes,
        extension,
        nomeArquivo: file.nomeArquivo,
        signal: params.signal,
      });

      await finalizeArquivoRow(db, arquivoId, {
        textoExtraido: result.texto,
        statusTratamento: "ok",
      });
      summary.ok += 1;
    } catch (err) {
      const status: StatusTratamento = err instanceof UnsupportedFileError
        ? "nao_suportado"
        : "erro";

      if (status === "nao_suportado") summary.naoSuportado += 1;
      else summary.erro += 1;

      // Tenta registrar a linha do arquivo com o status de falha (visibilidade
      // na tela de detalhe), best-effort.
      await safeUpsertArquivoFailure(db, {
        avisoId: params.avisoId,
        nomeArquivo: file.nomeArquivo,
        extensao: extension,
        statusTratamento: status,
      });

      // Erro VISIVEL em erros_ingestao sem travar o lote (RNF-05).
      await recordIngestErro(db, {
        execucaoId: params.execucaoId ?? null,
        avisoId: params.avisoId,
        severidade: status === "nao_suportado" ? "baixa" : "media",
        etapa: "Tratamento",
        mensagem: status === "nao_suportado"
          ? `arquivo nao suportado (${extension || "sem extensao"}): ${
            file.nomeArquivo ?? file.url
          }`
          : `falha no tratamento do arquivo ${file.nomeArquivo ?? file.url}: ${errorMessage(err)}`,
      });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------
// Re-extracao a partir do binario preservado no Storage (reprocesso por item)
// ---------------------------------------------------------------------

export interface ReextractParams {
  avisoId: string;
  extractor: TextExtractor;
  bucket?: string;
  signal?: AbortSignal;
}

/**
 * Re-extrai o texto verbatim dos arquivos de um aviso A PARTIR DO BINARIO ja
 * preservado no Storage (links Effecti podem ter expirado). Usado pelo
 * reprocesso por item. Cada arquivo e isolado (RNF-05). Retorna o resumo.
 */
export async function reextractAvisoFiles(
  db: SupabaseClient,
  params: ReextractParams,
): Promise<FileProcessingSummary> {
  const bucket = params.bucket ?? getEnv().editaisBucket;
  const summary: FileProcessingSummary = { total: 0, ok: 0, erro: 0, naoSuportado: 0 };

  const { data, error } = await db
    .from("aviso_arquivos")
    .select("id, nome_arquivo, extensao, storage_path")
    .eq("aviso_id", params.avisoId);

  if (error) {
    throw new ExtractionError(`falha ao listar arquivos do aviso: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    id: string;
    nome_arquivo: string | null;
    extensao: string | null;
    storage_path: string | null;
  }>;

  for (const row of rows) {
    if (params.signal?.aborted) break;
    summary.total += 1;
    const extension = (row.extensao ?? "").toLowerCase();

    try {
      if (!row.storage_path) {
        throw new ExtractionError("binario indisponivel no Storage (storage_path ausente)");
      }
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        throw new UnsupportedFileError(extension);
      }

      const { data: blob, error: dlError } = await db.storage
        .from(bucket)
        .download(row.storage_path);
      if (dlError || !blob) {
        throw new ExtractionError(
          `falha ao baixar binario do Storage: ${dlError?.message ?? "vazio"}`,
        );
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());

      const result = await params.extractor.extract({
        bytes,
        extension,
        nomeArquivo: row.nome_arquivo,
        signal: params.signal,
      });

      await finalizeArquivoRow(db, row.id, {
        textoExtraido: result.texto,
        statusTratamento: "ok",
      });
      summary.ok += 1;
    } catch (err) {
      const status: StatusTratamento = err instanceof UnsupportedFileError
        ? "nao_suportado"
        : "erro";
      if (status === "nao_suportado") summary.naoSuportado += 1;
      else summary.erro += 1;

      await db
        .from("aviso_arquivos")
        .update({ status_tratamento: status })
        .eq("id", row.id);

      await recordIngestErro(db, {
        avisoId: params.avisoId,
        severidade: status === "nao_suportado" ? "baixa" : "media",
        etapa: "Tratamento",
        mensagem: `falha na re-extracao do arquivo ${row.nome_arquivo ?? row.id}: ${
          errorMessage(err)
        }`,
      });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------
// Extracao de links de arquivo a partir do payload do aviso
// ---------------------------------------------------------------------

const URL_RE = /^https?:\/\/\S+$/i;
const FILE_KEYS = ["arquivos", "anexos", "documentos", "files", "attachments", "links"];

/**
 * Varre o payload bruto do aviso procurando links de arquivos de edital.
 * Reconhece arrays sob chaves conhecidas (arquivos/anexos/...) e objetos com
 * url/nome. Deduplica por URL. Defensivo a formatos variados da API.
 */
export function extractFileLinks(payload: unknown): FileToProcess[] {
  const found = new Map<string, FileToProcess>();
  walk(payload, found, 0);
  return Array.from(found.values());
}

function walk(node: unknown, acc: Map<string, FileToProcess>, depth: number): void {
  if (depth > 6 || node === null || node === undefined) return;

  if (typeof node === "string") {
    if (URL_RE.test(node) && looksLikeFile(node)) {
      if (!acc.has(node)) acc.set(node, { url: node, nomeArquivo: fileNameFromUrl(node) });
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) walk(item, acc, depth + 1);
    return;
  }

  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const url = firstUrl(obj, ["url", "link", "href", "downloadUrl", "arquivo"]);
    if (url) {
      const nome = firstStringValue(obj, ["nome", "nomeArquivo", "filename", "name", "titulo"]);
      if (!acc.has(url)) acc.set(url, { url, nomeArquivo: nome ?? fileNameFromUrl(url) });
    }
    // Continua a varredura: chaves conhecidas primeiro, depois o resto.
    for (const key of FILE_KEYS) {
      if (key in obj) walk(obj[key], acc, depth + 1);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (!FILE_KEYS.includes(key)) walk(value, acc, depth + 1);
    }
  }
}

function firstUrl(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && URL_RE.test(value)) return value;
  }
  return null;
}

function firstStringValue(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function looksLikeFile(url: string): boolean {
  const ext = extensionFromPath(url);
  if (ext && (SUPPORTED_EXTENSIONS.has(ext) || OCR_ELIGIBLE_EXTENSIONS.has(ext))) return true;
  // URLs de download sem extensao explicita tambem sao consideradas.
  return /(download|arquivo|anexo|documento|file)/i.test(url);
}

// ---------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------

async function downloadBinary(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      throw new FileDownloadError(`download falhou (${res.status}) em ${url}`);
    }
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new FileDownloadError(
        `arquivo excede o limite de ${MAX_DOWNLOAD_BYTES} bytes`,
      );
    }
    return {
      bytes: new Uint8Array(buffer),
      contentType: res.headers.get("Content-Type"),
    };
  } catch (err) {
    if (err instanceof FileDownloadError) throw err;
    if (isAbortError(err)) {
      throw new FileDownloadError(`tempo de download excedido em ${url}`);
    }
    throw new FileDownloadError(`falha de rede ao baixar ${url}: ${errorMessage(err)}`);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function upsertArquivoRow(
  db: SupabaseClient,
  params: {
    avisoId: string;
    nomeArquivo: string | null;
    extensao: string;
    tamanhoBytes: number;
    storagePath: string;
  },
): Promise<string> {
  const { data, error } = await db
    .from("aviso_arquivos")
    .insert({
      aviso_id: params.avisoId,
      nome_arquivo: params.nomeArquivo,
      extensao: params.extensao,
      tamanho_bytes: params.tamanhoBytes,
      storage_path: params.storagePath,
      status_tratamento: null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new ExtractionError(`falha ao registrar aviso_arquivos: ${error?.message ?? "sem id"}`);
  }
  return String((data as { id: string }).id);
}

async function finalizeArquivoRow(
  db: SupabaseClient,
  arquivoId: string,
  params: { textoExtraido: string; statusTratamento: StatusTratamento },
): Promise<void> {
  const { error } = await db
    .from("aviso_arquivos")
    .update({
      texto_extraido: params.textoExtraido,
      status_tratamento: params.statusTratamento,
    })
    .eq("id", arquivoId);
  if (error) {
    throw new ExtractionError(`falha ao gravar texto extraido: ${error.message}`);
  }
}

/** Best-effort: registra a linha do arquivo com status de falha. */
async function safeUpsertArquivoFailure(
  db: SupabaseClient,
  params: {
    avisoId: string;
    nomeArquivo: string | null;
    extensao: string;
    statusTratamento: StatusTratamento;
  },
): Promise<void> {
  try {
    await db.from("aviso_arquivos").insert({
      aviso_id: params.avisoId,
      nome_arquivo: params.nomeArquivo,
      extensao: params.extensao || null,
      status_tratamento: params.statusTratamento,
    });
  } catch (err) {
    console.error("[file-processing] falha ao registrar arquivo com erro", {
      avisoId: params.avisoId,
      err: errorMessage(err),
    });
  }
}

function resolveExtension(file: FileToProcess): string {
  return (
    extensionFromPath(file.nomeArquivo ?? "") ?? extensionFromPath(file.url) ?? ""
  );
}

function extensionFromPath(path: string): string | null {
  try {
    const clean = path.split("?")[0].split("#")[0];
    const base = clean.substring(clean.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    if (dot <= 0 || dot === base.length - 1) return null;
    return base.substring(dot + 1).toLowerCase();
  } catch {
    return null;
  }
}

function fileNameFromUrl(url: string): string | null {
  try {
    const clean = url.split("?")[0].split("#")[0];
    const base = clean.substring(clean.lastIndexOf("/") + 1);
    return base.length > 0 ? decodeURIComponent(base) : null;
  } catch {
    return null;
  }
}

function buildStoragePath(avisoId: string, extension: string): string {
  const suffix = extension ? `.${extension}` : "";
  return `${avisoId}/${crypto.randomUUID()}${suffix}`;
}

function parseExtractionText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload === null || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  const text = obj.text ?? obj.texto ?? obj.content ?? obj.conteudo;
  return typeof text === "string" ? text : "";
}

/** Copia os bytes para um ArrayBuffer "puro" (evita SharedArrayBuffer no tipo). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "AbortError"
    : err instanceof Error && err.name === "AbortError";
}
