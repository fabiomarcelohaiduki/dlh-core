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

// Margem que o client (AbortController) espera ALEM do timeout do Tika, para
// receber o erro/resultado de timeout do servidor antes de desistir. Sem ela,
// client e servidor cortariam no mesmo instante (corrida) e mascarariam o motivo.
const TIKA_CLIENT_MARGEM_MS = 60_000;

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

export class ExtracaoError extends Error {
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

/**
 * Distingue OOXML/ODT de um .zip puro lendo o nome da 1a entrada do ZIP
 * (offset 30, tamanho em 26-27). OOXML comeca com "[Content_Types].xml";
 * ODT comeca com "mimetype". Qualquer outra coisa = container generico.
 */
function sniffZipFamily(bytes) {
  try {
    if (bytes.byteLength < 34) return "zip";
    const nomeLen = bytes[26] | (bytes[27] << 8);
    const nome = new TextDecoder("latin1").decode(bytes.subarray(30, 30 + nomeLen));
    if (nome === "[Content_Types].xml") return "docx"; // ooxml -> Tika resolve o subtipo real
    if (nome === "mimetype") return "odt";
    return "zip";
  } catch {
    return "zip";
  }
}

/**
 * Detecta o tipo por ASSINATURA (magic bytes) quando o nome nao da uma
 * extensao reconhecida. Anexos do Effecti chegam com nome-titulo
 * ("EDITAL 59/26 677kB") sem extensao real -> detectarExtensao devolve lixo
 * ("", "kb"...) e a allowlist barra um PDF valido antes do Tika. Aqui olhamos
 * os primeiros bytes para recuperar o tipo. "" quando nao reconhece (mantem o
 * comportamento anterior). O label so serve p/ roteamento+allowlist; o Tika
 * faz a deteccao real do subtipo pelos proprios bytes.
 */
function detectarPorAssinatura(bytes) {
  if (!bytes || bytes.byteLength < 4) return "";
  const b = bytes;
  // %PDF
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";
  // {\rtf
  if (b[0] === 0x7b && b[1] === 0x5c && b[2] === 0x72 && b[3] === 0x74 && b[4] === 0x66) return "rtf";
  // OLE2 (doc/xls/ppt legados): D0 CF 11 E0
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "doc";
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  // JPG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  // GIF8
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  // TIFF (II* / MM*)
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return "tiff";
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  // 7z
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return "7z";
  // RAR
  if (b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21) return "rar";
  // ZIP-family (PK\x03\x04 / \x05\x06 / \x07\x08): zip puro OU OOXML OU ODT.
  if (b[0] === 0x50 && b[1] === 0x4b &&
    (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
    return sniffZipFamily(bytes);
  }
  return "";
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

/**
 * Header HTTP e ByteString (latin1): codepoints > 255 quebram o fetch
 * ("character ... is greater than 255"). O nome aqui e SO dica de tipo pro
 * Tika, entao trocamos os chars fora do latin1 (ex.: U+FFFD de nome corrompido)
 * por "_" e escapamos aspas/controle/barra que invalidariam o fil="...".
 */
function nomeSeguroHeader(nome) {
  return String(nome)
    .replace(/[\u0100-\uFFFF]/g, "_")
    .replace(/[\u0000-\u001f"\\]/g, "_");
}

/** Envia os bytes ao Tika e recebe text/plain. Tika detecta o tipo sozinho. */
async function extrairViaTika({ bytes, nomeArquivo, extension, config }) {
  const headers = {
    Accept: "text/plain; charset=UTF-8",
    "Content-Type": "application/octet-stream",
  };
  // Ajuda a deteccao de tipo do Tika pelo nome do arquivo.
  if (nomeArquivo) {
    headers["Content-Disposition"] = `attachment; filename="${nomeSeguroHeader(nomeArquivo)}"`;
  }

  // Estrategia de OCR (PDF). Imagens sempre passam por OCR no Tika full.
  const estrategia = config.ocrEstrategia === "nunca"
    ? "no_ocr"
    : config.ocrEstrategia === "sempre"
    ? "ocr_and_text"
    : "auto";
  headers["X-Tika-PDFOcrStrategy"] = estrategia;
  if (estrategia !== "no_ocr") headers["X-Tika-OCRLanguage"] = config.ocrIdioma;
  // Alinha o watchdog INTERNO do Tika (taskTimeoutMillis, default 300s) ao nosso
  // teto: sem isso o Tika mata o parse aos 5min e REINICIA o forked process,
  // derrubando o fetch (tika_net) antes do nosso timeout de client valer.
  headers["X-Tika-Timeout-Millis"] = String(config.timeoutMs);

  const controller = new AbortController();
  // Client espera um pouco MAIS que o Tika para receber o erro/resultado antes
  // de abortar (evita corrida que mascara o motivo real do estouro).
  const timer = setTimeout(() => controller.abort(), config.timeoutMs + TIKA_CLIENT_MARGEM_MS);
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
 * Descompacta+extrai via Tika RECURSIVO (/rmeta/text). O Tika `full` ja traz
 * commons-compress (7z/tar) e junrar (RAR4) e roda Tesseract nos membros, entao
 * NAO precisamos de binario externo (o 7za do 7zip-bin nao decodifica RAR).
 * A resposta e um JSON array: [0] e o container (sem texto util) e [1..] os
 * arquivos embutidos, cada um com "X-TIKA:content". Concatenamos os membros.
 */
async function extrairViaTikaRecursivo({ bytes, nomeArquivo, extension, config }) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/octet-stream",
  };
  if (nomeArquivo) {
    headers["Content-Disposition"] = `attachment; filename="${nomeSeguroHeader(nomeArquivo)}"`;
  }
  const estrategia = config.ocrEstrategia === "nunca"
    ? "no_ocr"
    : config.ocrEstrategia === "sempre"
    ? "ocr_and_text"
    : "auto";
  headers["X-Tika-PDFOcrStrategy"] = estrategia;
  if (estrategia !== "no_ocr") headers["X-Tika-OCRLanguage"] = config.ocrIdioma;
  // Alinha o watchdog INTERNO do Tika (taskTimeoutMillis, default 300s) ao nosso
  // teto: sem isso o Tika mata o parse aos 5min e REINICIA o forked process,
  // derrubando o fetch (tika_net) antes do nosso timeout de client valer.
  headers["X-Tika-Timeout-Millis"] = String(config.timeoutMs);

  const controller = new AbortController();
  // Client espera um pouco MAIS que o Tika para receber o erro/resultado antes
  // de abortar (evita corrida que mascara o motivo real do estouro).
  const timer = setTimeout(() => controller.abort(), config.timeoutMs + TIKA_CLIENT_MARGEM_MS);
  try {
    const res = await fetch(`${TIKA_ENDPOINT}/rmeta/text`, {
      method: "PUT",
      headers,
      body: bytes,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new ExtracaoError(`Tika respondeu ${res.status} para ${nomeArquivo ?? extension}`, "tika_http");
    }
    const partes = await res.json();
    if (!Array.isArray(partes)) {
      throw new ExtracaoError("resposta recursiva do Tika inesperada", "tika_rmeta");
    }
    const blocos = [];
    for (let i = 1; i < partes.length; i++) {
      const p = partes[i] ?? {};
      const conteudo = typeof p["X-TIKA:content"] === "string" ? p["X-TIKA:content"].trim() : "";
      if (!conteudo) continue;
      const nome = p["resourceName"] ?? p["X-TIKA:embedded_resource_path"] ?? `membro_${i}`;
      blocos.push(`\n===== ${nome} =====\n${conteudo}`);
    }
    return { texto: blocos.join("\n").trim(), usouOcr: estrategia !== "no_ocr" };
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
 * Desempacota um container e extrai cada membro. ZIP via adm-zip (controle por
 * membro do OCR). RAR/7Z via Tika recursivo (/rmeta/text), que ja desempacota e
 * extrai sem dependencia nova. Deps carregadas sob demanda (so o job precisa).
 */
async function extrairCompactado({ bytes, nomeArquivo, extension, config }) {
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
      try {
        const r = await extrairTexto({
          bytes: membroBytes,
          nomeArquivo: entry.entryName,
          config,
        });
        partes.push(`\n===== ${entry.entryName} =====\n${r.texto}`);
      } catch (err) {
        // Um membro nao-extraivel NAO pode derrubar o container inteiro:
        // pula o membro e segue com os demais. Cobre assinaturas (.p7s),
        // partes internas de OOXML mal-detectado como zip puro (.rels) e
        // formatos proprietarios sem allowlist (.kit etc.).
        const motivo = err instanceof ExtracaoError ? err.code : "erro";
        partes.push(`\n===== ${entry.entryName} (ignorado: ${motivo}) =====`);
      }
    }
    return { texto: partes.join("\n").trim(), usouOcr: false };
  }
  if (extension === "rar" || extension === "7z") {
    return await extrairViaTikaRecursivo({
      bytes,
      nomeArquivo: nomeArquivo ?? `arquivo.${extension}`,
      extension,
      config,
    });
  }
  throw new ExtracaoError(
    `extensao compactada '${extension}' nao suportada`,
    "compactado_nao_suportado",
  );
}

/**
 * Ponto de entrada agnostico. bytes + nome -> { texto, usouOcr, hashes, via, ext }.
 * `via` indica o caminho usado: "texto" | "tika" | "compactado".
 * `ext` e a extensao efetiva ja resolvida (nome ou magic bytes), usada a jusante
 * para classificar escaneados/imagens que so dao texto via OCR.
 */
export async function extrairTexto({ bytes, nomeArquivo = null, extension = null, config = {} }) {
  const cfg = { ...CONFIG_PADRAO, ...config };
  let ext = detectarExtensao(nomeArquivo, extension);

  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.byteLength === 0) throw new ExtracaoError("arquivo vazio (0 bytes)", "vazio");
  if (bytes.byteLength > cfg.tamanhoMaxBytes) {
    throw new ExtracaoError(
      `arquivo excede o limite (${bytes.byteLength} > ${cfg.tamanhoMaxBytes} bytes)`,
      "muito_grande",
    );
  }

  const allow = cfg.extensoesHabilitadas
    ? (cfg.extensoesHabilitadas instanceof Set
      ? cfg.extensoesHabilitadas
      : new Set(cfg.extensoesHabilitadas))
    : null;

  // Fallback por assinatura: quando o nome nao deu extensao reconhecida (anexo
  // Effecti com nome-titulo), re-detecta pelos bytes para nao barrar um PDF
  // valido na allowlist. So sobrescreve se a assinatura devolver algo.
  if (!ext || (allow && !allow.has(ext))) {
    const porAssinatura = detectarPorAssinatura(bytes);
    if (porAssinatura) ext = porAssinatura;
  }

  if (allow && !allow.has(ext)) {
    throw new ExtracaoError(`extensao '${ext}' desabilitada na config`, "extensao_desabilitada");
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
    ({ texto, usouOcr } = await extrairCompactado({ bytes, nomeArquivo, extension: ext, config: cfg }));
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
    ext,
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
