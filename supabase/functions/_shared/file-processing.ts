// =====================================================================
// _shared/file-processing.ts
// Interface de tratamento de arquivos de edital (US-19, RF-33, RF-36).
//
// Expoe DUAS pecas reutilizaveis, agnosticas de fonte:
//   1. extractFileLinks(payload): varre o payload bruto do aviso e devolve os
//      links de arquivos candidatos (dedupe por URL).
//   2. TextExtractor / ServiceTextExtractor / createTextExtractor: contrato do
//      motor de extracao verbatim (PDF/DOC/...; OCR como fallback), delegado a
//      um servico self-hosted via HTTP (engine trocavel).
//
// A trilha v0 (download do binario + preservacao no Storage privado +
// persistencia em aviso_arquivos) foi APOSENTADA: a decisao 2026-06-08 e NAO
// guardar binario, so o conteudo extraido. O pipeline de documentos (Tika no
// runner) substitui aquela trilha; aqui fica apenas a interface reutilizavel.
// =====================================================================

import { getEnv } from "./env.ts";
import { errorMessage } from "./ingest-errors.ts";

// ---------------------------------------------------------------------
// Tipos publicos
// ---------------------------------------------------------------------

/** Arquivo candidato extraido do payload do aviso. */
export interface FileToProcess {
  url: string;
  nomeArquivo: string | null;
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

const EXTRACTION_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------
// Erros tipados do tratamento (causa conhecida)
// ---------------------------------------------------------------------

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
