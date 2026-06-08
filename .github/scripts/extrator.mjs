// =====================================================================
// .github/scripts/extrator.mjs
// EXTRATOR CAMADA 1 (agnostico de fonte). Runner Node do GitHub Actions.
//
// Contrato: recebe BYTES + nome + extensao, devolve PURO TEXTO + hashes de
// dedup. Zero LLM, zero JSON estruturado, determinismo. A estruturacao dos
// campos (JSON dos 12 campos) e a CAMADA 2, separada, sobre este texto.
//
// O documento e cidadao de 1a classe: a FONTE (Nomus base64, Effecti URL,
// Gmail anexo, Drive API) e so um adaptador que entrega os bytes. Este modulo
// NAO sabe de onde veio o arquivo.
//
// Dispatch por extensao:
//   - texto puro (txt/csv/md/json/xml/html...) -> decodifica no Node, sem Tika;
//   - compactado (zip/rar/7z) -> desempacota e extrai cada membro (recursao);
//   - resto (pdf/doc/docx/rtf/odt/xls/ppt/imagens) -> Apache Tika (OCR embutido).
//
// Tika roda como service container do Actions (localhost:9998), efemero. O
// endpoint e configuravel (TIKA_ENDPOINT) para futuramente apontar um Tika
// parado sem reescrever nada.
//
// Saida: { texto, usouOcr, sha256Bytes, hashTextoNormalizado, via }.
//   sha256Bytes          = atalho de dedup byte-a-byte (identicos);
//   hashTextoNormalizado = dedup por conteudo (mesmo edital re-salvo/recomprimido,
//                          bytes diferentes mas texto identico).
// =====================================================================

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const TIKA_ENDPOINT = (process.env.TIKA_ENDPOINT?.trim() || "http://localhost:9998").replace(
  /\/+$/,
  "",
);

// Extensoes que sao texto puro: decodificadas no Node, nunca vao ao Tika.
const TEXTO_PURO = new Set([
  "txt", "csv", "tsv", "md", "markdown", "json", "log", "yaml", "yml",
]);
// Texto puro mas com marcacao: decodifica + strip leve de tags.
const MARCACAO = new Set(["html", "htm", "xml"]);
// Arquivos-container: desempacotados no runner, cada membro re-extraido.
const COMPACTADO = new Set(["zip", "rar", "7z"]);
// Imagens: o Tika so produz texto via OCR (Tesseract). Marca usouOcr=true.
const IMAGEM = new Set(["png", "jpg", "jpeg", "tif", "tiff", "gif", "bmp", "webp"]);

/** Config administravel (espelha config_extracao no Supabase). */
export const CONFIG_PADRAO = Object.freeze({
  // "auto" (OCR so quando o PDF nao tem camada de texto), "sempre"
  // (ocr_and_text) ou "nunca" (no_ocr).
  ocrEstrategia: "auto",
  ocrIdioma: "por+eng",
  tamanhoMaxBytes: 100 * 1024 * 1024, // 100 MiB
  timeoutMs: 120_000,
  // null = todas habilitadas; ou um Set/array de extensoes permitidas.
  extensoesHabilitadas: null,
});

class ExtracaoError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ExtracaoError";
    this.code = code;
  }
}

/** Extensao em minusculo, sem ponto. Deriva do nome quando nao for explicita. */
export function detectarExtensao(nomeArquivo, explicita) {
  if (explicita && explicita.trim()) return explicita.trim().toLowerCase().replace(/^\./, "");
  if (!nomeArquivo) return "";
  const m = String(nomeArquivo).toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/);
  return m ? m[1] : "";
}

/** SHA-256 hex dos bytes crus. */
export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Hash do texto NORMALIZADO: tira acentos, caixa e colapsa espacos/quebras.
 * Pega "mesmo edital, PDF re-salvo" onde os bytes mudam mas o texto e igual.
 */
export function hashTextoNormalizado(texto) {
  const norm = texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(norm, "utf8").digest("hex");
}

function decodeBytes(bytes) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Muitos U+FFFD => provavelmente latin1 (comum em arquivos BR antigos).
  const ruido = (utf8.match(/\uFFFD/g) || []).length;
  if (ruido > 0 && ruido > utf8.length * 0.01) {
    return new TextDecoder("latin1").decode(bytes);
  }
  return utf8;
}

function stripTags(texto) {
  return texto
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Envia os bytes ao Tika e recebe text/plain. Tika detecta o tipo sozinho. */
async function extrairViaTika({ bytes, nomeArquivo, extension, config }) {
  const headers = {
    Accept: "text/plain; charset=UTF-8",
    "Content-Type": "application/octet-stream",
  };
  // Ajuda a deteccao de tipo do Tika pelo nome do arquivo.
  if (nomeArquivo) headers["Content-Disposition"] = `attachment; filename="${nomeArquivo}"`;

  // Estrategia de OCR (PDF). Imagens sempre passam por OCR no Tika full.
  const estrategia = config.ocrEstrategia === "nunca"
    ? "no_ocr"
    : config.ocrEstrategia === "sempre"
    ? "ocr_and_text"
    : "auto";
  headers["X-Tika-PDFOcrStrategy"] = estrategia;
  if (estrategia !== "no_ocr") headers["X-Tika-OCRLanguage"] = config.ocrIdioma;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(`${TIKA_ENDPOINT}/tika`, {
      method: "PUT",
      headers,
      body: bytes,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new ExtracaoError(`Tika respondeu ${res.status} para ${nomeArquivo ?? extension}`, "tika_http");
    }
    const texto = await res.text();
    return { texto, usouOcr: IMAGEM.has(extension) };
  } catch (err) {
    if (err instanceof ExtracaoError) throw err;
    if (err?.name === "AbortError") {
      throw new ExtracaoError(`Tika excedeu ${config.timeoutMs}ms`, "timeout");
    }
    throw new ExtracaoError(`falha ao contatar o Tika (${TIKA_ENDPOINT}): ${err?.message ?? err}`, "tika_net");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Desempacota um container e extrai cada membro. ZIP via adm-zip; RAR/7Z via
 * node-7z/7zip-bin. Deps carregadas sob demanda (so o job de extracao precisa).
 */
async function extrairCompactado({ bytes, extension, config }) {
  if (extension === "zip") {
    let AdmZip;
    try {
      ({ default: AdmZip } = await import("adm-zip"));
    } catch {
      throw new ExtracaoError("dependencia 'adm-zip' ausente (npm i adm-zip)", "dep_faltando");
    }
    const zip = new AdmZip(Buffer.from(bytes));
    const partes = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const membroBytes = new Uint8Array(entry.getData());
      const r = await extrairTexto({
        bytes: membroBytes,
        nomeArquivo: entry.entryName,
        config,
      });
      partes.push(`\n===== ${entry.entryName} =====\n${r.texto}`);
    }
    return { texto: partes.join("\n").trim(), usouOcr: false };
  }
  throw new ExtracaoError(
    `extensao compactada '${extension}' ainda nao implementada (RAR/7Z exigem 7zip-bin)`,
    "compactado_nao_suportado",
  );
}

/**
 * Ponto de entrada agnostico. bytes + nome -> { texto, usouOcr, hashes, via }.
 * `via` indica o caminho usado: "texto" | "tika" | "compactado".
 */
export async function extrairTexto({ bytes, nomeArquivo = null, extension = null, config = {} }) {
  const cfg = { ...CONFIG_PADRAO, ...config };
  const ext = detectarExtensao(nomeArquivo, extension);

  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.byteLength === 0) throw new ExtracaoError("arquivo vazio (0 bytes)", "vazio");
  if (bytes.byteLength > cfg.tamanhoMaxBytes) {
    throw new ExtracaoError(
      `arquivo excede o limite (${bytes.byteLength} > ${cfg.tamanhoMaxBytes} bytes)`,
      "muito_grande",
    );
  }
  if (cfg.extensoesHabilitadas) {
    const allow = cfg.extensoesHabilitadas instanceof Set
      ? cfg.extensoesHabilitadas
      : new Set(cfg.extensoesHabilitadas);
    if (!allow.has(ext)) {
      throw new ExtracaoError(`extensao '${ext}' desabilitada na config`, "extensao_desabilitada");
    }
  }

  const sha = sha256Bytes(bytes);

  let texto;
  let usouOcr = false;
  let via;
  if (TEXTO_PURO.has(ext)) {
    texto = decodeBytes(bytes);
    via = "texto";
  } else if (MARCACAO.has(ext)) {
    texto = stripTags(decodeBytes(bytes));
    via = "texto";
  } else if (COMPACTADO.has(ext)) {
    ({ texto, usouOcr } = await extrairCompactado({ bytes, extension: ext, config: cfg }));
    via = "compactado";
  } else {
    ({ texto, usouOcr } = await extrairViaTika({ bytes, nomeArquivo, extension: ext, config: cfg }));
    via = "tika";
  }

  texto = (texto ?? "").trim();
  return {
    texto,
    usouOcr,
    sha256Bytes: sha,
    hashTextoNormalizado: texto ? hashTextoNormalizado(texto) : null,
    via,
  };
}

// ---------------------------------------------------------------------
// CLI de smoke test: node extrator.mjs <arquivo-local-ou-URL>
// Baixa/le os bytes e roda a extracao, imprimindo um resumo. Usado para
// validar o miolo com 1 edital real antes de plugar adaptadores e workflow.
// ---------------------------------------------------------------------
const invocadoDireto = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (invocadoDireto) {
  const alvo = process.argv[2];
  if (!alvo) {
    console.error("uso: node extrator.mjs <arquivo-local-ou-URL>");
    process.exit(2);
  }
  const t0 = Date.now();
  let bytes;
  let nome;
  if (/^https?:\/\//i.test(alvo)) {
    const res = await fetch(alvo);
    if (!res.ok) {
      console.error(`download falhou (${res.status}): ${alvo}`);
      process.exit(1);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
    nome = decodeURIComponent(alvo.split("/").pop()?.split("?")[0] || "download");
  } else {
    bytes = new Uint8Array(await readFile(alvo));
    nome = alvo.split(/[\\/]/).pop();
  }

  console.log(`arquivo: ${nome} (${bytes.byteLength} bytes)`);
  console.log(`tika:    ${TIKA_ENDPOINT}`);
  try {
    const r = await extrairTexto({ bytes, nomeArquivo: nome });
    console.log(`via:     ${r.via} | usouOcr=${r.usouOcr} | ${Date.now() - t0}ms`);
    console.log(`sha256:  ${r.sha256Bytes.slice(0, 16)}...`);
    console.log(`hashTxt: ${r.hashTextoNormalizado?.slice(0, 16) ?? "-"}...`);
    console.log(`texto:   ${r.texto.length} chars`);
    console.log("----- primeiros 800 chars -----");
    console.log(r.texto.slice(0, 800));
  } catch (err) {
    console.error(`ERRO [${err.code ?? "?"}]: ${err.message}`);
    process.exit(1);
  }
}
