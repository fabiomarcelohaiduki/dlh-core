// Orquestrador de extracao de anexos (camada 1), runner de NUVEM (Actions).
//
// CICLO: pede ao Edge documentos-ingerir os VINCULOS pendentes (+ a
// config_extracao administravel do cockpit), obtem os BYTES de cada anexo
// pelo ADAPTADOR da sua fonte, extrai o TEXTO com o miolo agnostico
// (extrator.mjs / Tika) e empurra os resultados de volta ao Edge, que faz
// dedup global, grava o texto e indexa (chunks/embeddings).
//
// POR QUE NO RUNNER: o Tika (motor de extracao/OCR) so vive aqui (servico
// efemero do Actions) e o Nomus so conecta via Node/OpenSSL (TLS legado). O
// Edge e o dono da persistencia (service_role + EMBEDDINGS_ENDPOINT). Mesma
// divisao do coletar-nomus.mjs.
//
// FONTE = so um adaptador de obtencao de bytes (documento e agnostico):
//   nomus   -> GET individual /rest/processos/{id}, anexoBase64 -> bytes
//   effecti -> GET na URL publica do anexo -> bytes
//   (drive/gmail = futuros; plugam aqui sem mexer no extrator)
//
// Env obrigatorias:
//   SUPABASE_URL           ex.: https://<ref>.supabase.co
//   CRON_DISPATCH_SECRET   segredo de sistema (X-Cron-Secret) do Edge
// Env por fonte (conforme o que houver pendente):
//   NOMUS_API_KEY          chave Basic do Nomus (adaptador nomus)
//   NOMUS_BASE_URL         default https://famaha.nomus.com.br/famaha
// Env opcionais:
//   SUPABASE_ANON_KEY      apikey do gateway (incluida quando presente)
//   TIKA_ENDPOINT          endpoint do Tika (default localhost:9998; lido pelo extrator)
//   EXTRACAO_LIMITE        tamanho do fetch por iteracao (default 500 = teto do Edge);
//                          o run RE-BUSCA em loop ate a fila esgotar ou o budget acabar
//   EXTRACAO_BUDGET_MS     teto de tempo do run em ms (default 5h; margem antes do corte de 6h)
//   EXTRACAO_PUSH_CHUNK    resultados por push ao Edge (default 3; texto e pesado)
//   EXTRACAO_MODO          "rapido" (default) ou "ocr". rapido roda com OCR OFF e
//                          empurra os escaneados/imagens para a fila 'precisa_ocr';
//                          ocr drena essa fila com OCR LIGADO e healthcheck do Tika.
//   OCR_TEXTO_MINIMO       no modo rapido, abaixo deste nº de chars um arquivo que
//                          so da texto via OCR (pdf escaneado/imagem) e enfileirado
//                          como precisa_ocr (default 50)

import { extrairTexto, ExtracaoError } from "./extrator.mjs";
import { baixarArquivoDrive, getDriveAccessToken } from "./drive.mjs";
import { baixarAnexo, extrairConteudo, obterMensagem, NOME_CORPO } from "./gmail.mjs";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const CRON_SECRET = process.env.CRON_DISPATCH_SECRET;
const ANON = process.env.SUPABASE_ANON_KEY;
const NOMUS_KEY = process.env.NOMUS_API_KEY;
const NOMUS_BASE = (process.env.NOMUS_BASE_URL?.trim() || "https://famaha.nomus.com.br/famaha")
  .replace(/\/+$/, "");

const PUSH_CHUNK = posInt(process.env.EXTRACAO_PUSH_CHUNK, 3);
const MAX_RETRIES = posInt(process.env.NOMUS_MAX_RETRIES, 5);
const BASE_DELAY_MS = 500;
const BACKOFF_TETO_MS = 60_000;

// rapido = OCR off + escaneados/imagens viram fila 'precisa_ocr'; ocr = drena
// essa fila com OCR ligado. Default rapido (preco de nao perder licitacao).
const MODO = process.env.EXTRACAO_MODO?.trim() === "ocr" ? "ocr" : "rapido";
const OCR_TEXTO_MINIMO = posInt(process.env.OCR_TEXTO_MINIMO, 50);
// Timeout PROPRIO do modo OCR. config_extracao.timeoutMs e calibrado para o
// passo RAPIDO (OCR off -> timeout grande so segura o Tika a toa); no modo OCR
// o trabalho e demorado de proposito (Tesseract pagina a pagina num escaneado),
// entao um timeout curto so converte escaneado grande em 'erro'. Aqui o run OCR
// usa o seu proprio teto, sobrepondo o config global; o rapido fica intocado.
const OCR_TIMEOUT_MS = posInt(process.env.OCR_TIMEOUT_MS, 600_000);
const TIKA_ENDPOINT = (process.env.TIKA_ENDPOINT?.trim() || "http://localhost:9998").replace(/\/+$/, "");
// Tipos que SO produzem texto via OCR quando nao tem camada de texto: PDF
// (nativo da texto sem OCR; escaneado nao) e imagens (sempre precisam de OCR).
const EXT_OCR = new Set(["pdf", "png", "jpg", "jpeg", "tif", "tiff", "gif", "bmp", "webp"]);

function posInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Codigos de ExtracaoError que sao TERMINAIS (reprocessar nao muda o resultado):
// arquivo vazio, excede o limite, extensao barrada na config, link de pagina
// (o "anexo" e na verdade uma pagina do portal, nao um arquivo). tika_net/
// timeout/tika_rmeta/dep_faltando/compactado_* ficam de FORA (transitorios).
const TERMINAIS_EXTRACAO = new Set([
  "vazio",
  "muito_grande",
  "extensao_desabilitada",
  "link_pagina",
]);

/**
 * Classifica um erro como INOBTENIVEL (estado terminal, nao reprocessavel) vs
 * transitorio (fica 'erro' e volta para a fila). Terminal = a FONTE removeu o
 * arquivo ou o conteudo e permanentemente nao-processavel; nenhum retry muda.
 * Decisao Fabio 2026-06-16 (ver migration 20260616110000).
 */
function ehInobtenivel(err) {
  if (err instanceof ExtracaoError) {
    if (TERMINAIS_EXTRACAO.has(err.code)) return true;
    // Tika respondeu 4xx: conteudo nao-processavel (corrompido/cifrado/formato).
    // 5xx/erro de rede sao tika_net (transitorio), nao chegam aqui como tika_http.
    if (err.code === "tika_http" && /respondeu 4\d\d /.test(err.message ?? "")) return true;
    return false;
  }
  const m = String(err?.message ?? "");
  if (/Gmail GET .* falhou \(404\)/.test(m)) return true;       // mensagem deletada
  if (/Gmail anexo de mensagem deletada/.test(m)) return true;  // anexo de msg 404 (500 no attachments.get)
  if (/download Effecti falhou \(4\d\d\)/.test(m)) return true; // PNCP "Arquivo excluido" etc.
  if (/nao encontrado no processo \d+/.test(m)) return true;    // anexo sumiu do processo Nomus
  return false;
}

function fail(msg, code = 2) {
  console.error(`ERRO: ${msg}`);
  process.exit(code);
}

if (!SUPABASE_URL) fail("env SUPABASE_URL ausente.");
if (!CRON_SECRET) fail("env CRON_DISPATCH_SECRET ausente.");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt) {
  const exp = BASE_DELAY_MS * 2 ** attempt;
  const capped = Math.min(exp, BACKOFF_TETO_MS);
  return Math.floor(capped + Math.random() * (capped * 0.2));
}

// ---------------------------------------------------------------------
// Edge documentos-ingerir
// ---------------------------------------------------------------------

const INGERIR_URL = `${SUPABASE_URL}/functions/v1/documentos-ingerir`;

function ingerirHeaders() {
  const headers = { "Content-Type": "application/json", "X-Cron-Secret": CRON_SECRET };
  if (ANON) {
    headers["apikey"] = ANON;
    headers["Authorization"] = `Bearer ${ANON}`;
  }
  return headers;
}

async function postEdge(body) {
  const res = await fetch(INGERIR_URL, {
    method: "POST",
    headers: ingerirHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    // mantem text cru.
  }
  return { status: res.status, ok: res.ok, json, text };
}

/** Pede vinculos pendentes + config_extracao ao Edge (fila conforme o modo). */
async function fetchPendentes(limite) {
  const r = await postEdge({ action: "pendentes", modo: MODO, ...(limite ? { limite } : {}) });
  if (!r.ok) fail(`falha ao listar pendentes (${r.status}): ${r.text.slice(0, 300)}`, 1);
  return { pendentes: r.json?.pendentes ?? [], config: r.json?.config ?? null };
}

/** Uma sondagem do /version do Tika com teto de 5s. */
async function tikaPing() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(`${TIKA_ENDPOINT}/version`, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    return false;
  }
}

/**
 * Healthcheck do Tika (GET /version) com tolerancia a reinicio. Usado no modo
 * OCR para abortar o run cedo se o servico do Actions caiu/ficou preso — sem
 * torrar o budget em timeouts encadeados. Mas o Tika `full` REINICIA o forked
 * process em ~1-2s quando o watchdog interno mata um parse pesado; uma sondagem
 * unica nesse instante daria falso-negativo e abortaria o run a toa. Por isso
 * tentamos algumas vezes com pausa antes de declarar o Tika morto.
 */
async function tikaVivo() {
  for (let i = 0; i < 5; i++) {
    if (await tikaPing()) return true;
    if (i < 4) await delay(2_000);
  }
  return false;
}

// ---------------------------------------------------------------------
// Rate-limit do Nomus no corpo ({tempoAteLiberar:<seg>}); por vezes com 200.
// ---------------------------------------------------------------------

function peekTempoAteLiberar(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const t = j.tempoAteLiberar;
      if (typeof t === "number" && Number.isFinite(t) && t > 0) return t * 1000;
    }
  } catch (_) {
    // corpo nao-JSON: ignora.
  }
  return null;
}

// ---------------------------------------------------------------------
// Adaptadores de fonte: ref_obtencao -> { bytes, nomeArquivo, extensao }
// ---------------------------------------------------------------------

/**
 * Nomus: o anexo (base64) vive SO no GET individual /rest/processos/{id}
 * (a listagem nao traz base64). Re-obtem por demanda e acha o anexo por nome.
 */
async function obterBytesNomus(ref) {
  if (!NOMUS_KEY) throw new Error("NOMUS_API_KEY ausente para o adaptador nomus");
  const processoId = ref?.processo_id;
  const nome = ref?.nome;
  if (!processoId) throw new Error("ref_obtencao.processo_id ausente (nomus)");

  const url = `${NOMUS_BASE}/rest/processos/${encodeURIComponent(processoId)}`;
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${NOMUS_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw new Error(`rede Nomus (proc ${processoId}): ${err?.message ?? err}`);
      await delay(backoff(attempt));
      attempt += 1;
      continue;
    }
    if (res.status === 401) throw new Error("credencial Nomus invalida (401)");
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`Nomus indisponivel (${res.status})`);
      const retryAfter = Number(res.headers.get("Retry-After"));
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      attempt += 1;
      continue;
    }
    if (!res.ok) throw new Error(`Nomus rejeitou (${res.status})`);

    const text = await res.text();
    const tempoMs = peekTempoAteLiberar(text);
    if (tempoMs !== null) {
      if (attempt >= MAX_RETRIES) throw new Error("Nomus rate-limit (tempoAteLiberar)");
      await delay(tempoMs + 1_000);
      attempt += 1;
      continue;
    }

    let proc;
    try {
      proc = JSON.parse(text);
    } catch (_) {
      throw new Error(`resposta nao-JSON do Nomus (proc ${processoId})`);
    }
    const anexos = Array.isArray(proc?.arquivosAnexos) ? proc.arquivosAnexos : [];
    const alvo = nome
      ? anexos.find((a) => a && a.nome === nome)
      : anexos.find((a) => a && typeof a.anexoBase64 === "string");
    if (!alvo) throw new Error(`anexo "${nome ?? "(qualquer)"}" nao encontrado no processo ${processoId}`);
    if (typeof alvo.anexoBase64 !== "string" || alvo.anexoBase64 === "") {
      throw new Error(`anexo "${alvo.nome}" sem base64 no processo ${processoId}`);
    }
    const bytes = new Uint8Array(Buffer.from(alvo.anexoBase64, "base64"));
    return { bytes, nomeArquivo: alvo.nome ?? nome ?? "anexo", extensao: alvo.extensao ?? null };
  }
}

/**
 * Normaliza a URL de anexo do Effecti. O PNCP so atende em 443, mas a
 * descoberta as vezes guarda uma porta efemera (ex pncp.gov.br:52569) que ja
 * morreu -> o fetch trava e morre como "fetch failed" em 100% dos casos.
 * Descartar a porta nao-padrao do host pncp.gov.br restaura o download.
 */
function normalizarUrlEffecti(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === "pncp.gov.br" && u.port) u.port = "";
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Effecti: a URL do anexo e publica e nao expira (CDN content-addressed do
 * Compras Publicas; ComprasNet via middleware pode exigir token Effecti -
 * tratar quando exercido). Re-fetchavel por demanda.
 */
async function obterBytesEffecti(ref) {
  const rawUrl = ref?.url;
  if (!rawUrl) throw new Error("ref_obtencao.url ausente (effecti)");
  const url = normalizarUrlEffecti(rawUrl);
  // Retry/backoff (mesmo padrao do adaptador nomus): a URL do CDN/middleware
  // pode recusar em rajada numa janela de rede ruim do runner. Sem retry, uma
  // janela curta derrubava dezenas de downloads em serie como "fetch failed".
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(url, { method: "GET" });
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`download Effecti falhou (rede): ${err?.message ?? err}`);
      }
      await delay(backoff(attempt));
      attempt += 1;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`download Effecti indisponivel (${res.status})`);
      const retryAfter = Number(res.headers.get("Retry-After"));
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      attempt += 1;
      continue;
    }
    if (!res.ok) throw new Error(`download Effecti falhou (${res.status})`);
    // Alguns "anexos" do Effecti (ex "Esclarecimentos/Impugnacoes") nao sao
    // arquivos: a URL aponta para uma PAGINA dinamica do portal (ex
    // electronicRecord.ctlx do Banrisul) que so devolve uma casca de HTML inutil
    // sem a sessao do portal. Detecta pelo content-type text/html no download e
    // classifica como terminal benigno (nao reprocessar; link segue clicavel).
    const contentType = res.headers.get("content-type") ?? "";
    if (/^text\/html\b/i.test(contentType.trim())) {
      throw new ExtracaoError("link de pagina do portal (nao e arquivo)", "link_pagina");
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const nomeArquivo = ref?.nome
      ?? decodeURIComponent(String(url).split("/").pop()?.split("?")[0] || "anexo");
    return { bytes, nomeArquivo, extensao: ref?.extensao ?? null };
  }
}

/**
 * Drive: o anexo e re-obtido por demanda via API (alt=media), autenticando
 * com o refresh_token de longa duracao (opcao A). O documento e o mesmo
 * cidadao de 1a classe; muda so a obtencao dos bytes. ref_obtencao guarda o
 * file_id (estavel) e a assinatura de versao usada na re-descoberta.
 */
async function obterBytesDrive(ref) {
  const fileId = ref?.file_id;
  if (!fileId) throw new Error("ref_obtencao.file_id ausente (drive)");
  const token = await getDriveAccessToken();
  const bytes = await baixarArquivoDrive(fileId, token);
  return { bytes, nomeArquivo: ref?.nome ?? "arquivo", extensao: ref?.extensao ?? null };
}

/**
 * Gmail: coleta POR MENSAGEM (decisao Fabio 2026-06-09). Dois tipos de vinculo,
 * distintos pelo ref_obtencao.tipo, ambos re-obtidos por demanda (nada do
 * binario e guardado):
 *   - 'corpo' -> re-busca a mensagem, extrai o corpo limpo (sem citacao da
 *     thread) e entrega como texto .txt (o extrator decodifica no Node);
 *   - 'anexo' -> baixa os bytes do anexo (messages.attachments.get).
 */
async function obterBytesGmail(ref) {
  const messageId = ref?.message_id;
  if (!messageId) throw new Error("ref_obtencao.message_id ausente (gmail)");
  const tipo = ref?.tipo === "corpo" ? "corpo" : "anexo";

  if (tipo === "corpo") {
    const msg = await obterMensagem(messageId);
    const { corpo } = extrairConteudo(msg);
    if (!corpo) throw new Error(`mensagem ${messageId} sem corpo de texto`);
    const bytes = new Uint8Array(Buffer.from(corpo, "utf-8"));
    return { bytes, nomeArquivo: ref?.nome ?? NOME_CORPO, extensao: "txt" };
  }

  const attachmentId = ref?.attachment_id;
  if (!attachmentId) throw new Error("ref_obtencao.attachment_id ausente (gmail anexo)");
  try {
    const bytes = await baixarAnexo(messageId, attachmentId);
    return { bytes, nomeArquivo: ref?.nome ?? "anexo", extensao: ref?.extensao ?? null };
  } catch (err) {
    // Anexo de mensagem DELETADA: o Gmail responde 500 no attachments.get (em
    // vez de 404) quando a mensagem-pai sumiu. Confirma sondando a mensagem;
    // se ela tambem 404, e terminal (nenhum retry recupera) -> erro
    // reconhecido por ehInobtenivel. Caso contrario, propaga o erro original
    // (500 transitorio de verdade segue reprocessavel).
    if (await mensagemSumiu(messageId)) {
      throw new Error(`Gmail anexo de mensagem deletada (mensagem ${messageId} 404)`);
    }
    throw err;
  }
}

/** Sonda se a mensagem-pai do anexo ainda existe (404 => deletada). */
async function mensagemSumiu(messageId) {
  try {
    await obterMensagem(messageId);
    return false;
  } catch (err) {
    return /Gmail GET .* falhou \(404\)/.test(String(err?.message ?? ""));
  }
}

const ADAPTADORES = {
  nomus: obterBytesNomus,
  effecti: obterBytesEffecti,
  drive: obterBytesDrive,
  gmail: obterBytesGmail,
};

// ---------------------------------------------------------------------
// Processa 1 vinculo: obtem bytes -> extrai -> monta ResultadoExtracao.
// ---------------------------------------------------------------------

async function processarVinculo(vinculo, configExtrator) {
  const fonte = vinculo?.fonte;
  const adaptador = ADAPTADORES[fonte];
  if (!adaptador) {
    return { vinculo_id: vinculo.id, ok: false, erro: `fonte sem adaptador: ${fonte}` };
  }
  try {
    const ref = vinculo?.ref_obtencao ?? {};
    const { bytes, nomeArquivo, extensao } = await adaptador(ref);
    const r = await extrairTexto({
      bytes,
      nomeArquivo: vinculo?.nome_anexo ?? nomeArquivo,
      extension: extensao,
      config: configExtrator,
    });
    // Modo rapido (OCR off): um arquivo que so daria texto via OCR (PDF
    // escaneado/imagem) volta quase vazio. Em vez de gravar lixo, sinaliza
    // precisa_ocr -> o Edge enfileira e o passo OCR dedicado extrai depois.
    // Nativo (PDF com camada de texto) passa direto. No modo ocr nao se aplica.
    if (
      MODO === "rapido" && r.via === "tika" &&
      EXT_OCR.has(r.ext) && (r.texto?.length ?? 0) < OCR_TEXTO_MINIMO
    ) {
      return {
        vinculo_id: vinculo.id,
        ok: true,
        precisa_ocr: true,
        nome_arquivo: vinculo?.nome_anexo ?? nomeArquivo,
        extensao: extensao,
        tamanho_bytes: bytes.byteLength,
      };
    }
    return {
      vinculo_id: vinculo.id,
      ok: true,
      nome_arquivo: vinculo?.nome_anexo ?? nomeArquivo,
      extensao: extensao,
      tamanho_bytes: bytes.byteLength,
      sha256_bytes: r.sha256Bytes,
      hash_texto_normalizado: r.hashTextoNormalizado,
      texto: r.texto,
      usou_ocr: r.usouOcr,
      via: r.via,
    };
  } catch (err) {
    const code = err instanceof ExtracaoError ? `[${err.code}] ` : "";
    // inobtenivel = terminal (fonte removeu / nao-processavel): o Edge marca
    // status='inobtenivel' em vez de 'erro' -> sai da fila e nao reprocessa.
    return {
      vinculo_id: vinculo.id,
      ok: false,
      erro: `${code}${err?.message ?? err}`,
      inobtenivel: ehInobtenivel(err),
    };
  }
}

/** Mapeia a config_extracao (do Edge, camelCase) para o formato do extrator. */
function montarConfigExtrator(config) {
  if (!config || typeof config !== "object") return {};
  const out = {};
  if (config.ocrEstrategia != null) out.ocrEstrategia = config.ocrEstrategia;
  if (config.ocrIdioma != null) out.ocrIdioma = config.ocrIdioma;
  if (config.tamanhoMaxBytes != null) out.tamanhoMaxBytes = Number(config.tamanhoMaxBytes);
  if (config.timeoutMs != null) out.timeoutMs = Number(config.timeoutMs);
  if (Array.isArray(config.extensoesHabilitadas)) out.extensoesHabilitadas = config.extensoesHabilitadas;
  return out;
}

// ---------------------------------------------------------------------
// Push dos resultados ao Edge (em lotes; texto e pesado). INCREMENTAL:
// drena o buffer assim que junta PUSH_CHUNK resultados, liberando memoria
// e PERSISTINDO o que ja foi extraido. Resiliencia: se o run cair ou
// estourar o tempo do Actions no meio, o que ja foi empurrado nao se perde
// nem reextrai no proximo run (a fila so guarda os vinculos que faltam).
// ---------------------------------------------------------------------

const resumo = { recebidos: 0, novos: 0, herdados: 0, erros: 0, precisa_ocr: 0, inobtenivel: 0 };
let pushSeq = 0;

/** Empurra o buffer enquanto tiver >= `minimo` itens (drena removendo do buffer). */
async function drenarBuffer(buffer, minimo) {
  while (buffer.length > 0 && buffer.length >= minimo) {
    const lote = buffer.splice(0, PUSH_CHUNK);
    const r = await postEdge({ documentos: lote });
    if (!r.ok) fail(`push de resultados falhou (${r.status}): ${r.text.slice(0, 300)}`, 1);
    resumo.recebidos += r.json?.recebidos ?? lote.length;
    resumo.novos += r.json?.novos ?? 0;
    resumo.herdados += r.json?.herdados ?? 0;
    resumo.erros += r.json?.erros ?? 0;
    resumo.precisa_ocr += r.json?.precisa_ocr ?? 0;
    resumo.inobtenivel += r.json?.inobtenivel ?? 0;
    pushSeq += 1;
    console.error(
      `[push ${pushSeq}] enviados ${lote.length} | ` +
        `acum novos=${resumo.novos} herdados=${resumo.herdados} erros=${resumo.erros} ` +
        `precisa_ocr=${resumo.precisa_ocr} inobtenivel=${resumo.inobtenivel}`,
    );
  }
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

const startedAt = Date.now();

// EXTRACAO_LIMITE = tamanho do fetch por iteracao (teto do Edge = 500). Cada
// chamada 'pendentes' devolve no maximo este tanto; o loop abaixo RE-BUSCA ate
// a fila esgotar ou o budget de tempo acabar.
const fetchSize = posInt(process.env.EXTRACAO_LIMITE, 500);
// Budget de tempo do run: drena lotes em sequencia ate ~5h, deixando margem
// antes do corte de 6h do Actions. O que sobrar fica na fila para o proximo
// run (agendado) continuar. Os ja extraidos sairam de 'pendente' (push
// incremental), entao nunca reprocessam -> a fila so encolhe, sem loop infinito.
const budgetMs = posInt(process.env.EXTRACAO_BUDGET_MS, 5 * 60 * 60 * 1000);

let iter = 0;
let totalProcessados = 0;

while (true) {
  if (Date.now() - startedAt >= budgetMs) {
    console.log(
      `Budget de tempo atingido (${budgetMs}ms); encerrando para o proximo run continuar a fila.`,
    );
    break;
  }

  const { pendentes, config } = await fetchPendentes(fetchSize);
  if (pendentes.length === 0) {
    console.log(iter === 0 ? "Nenhum vinculo pendente de extracao." : "Fila de pendentes esvaziada.");
    break;
  }

  iter += 1;
  // Releitura da config a cada lote e barata e pega mudancas do cockpit em runs longos.
  const configExtrator = montarConfigExtrator(config);
  // O modo MANDA na estrategia de OCR, sobrepondo a config: rapido roda SEMPRE
  // com OCR off (o caro fica para a fila); ocr roda SEMPRE com OCR ligado.
  configExtrator.ocrEstrategia = MODO === "ocr" ? "sempre" : "nunca";
  // Pelo mesmo motivo, o modo OCR usa seu proprio teto de tempo (escaneado
  // grande estoura o timeout curto do passo rapido). Nao toca o rapido.
  if (MODO === "ocr") configExtrator.timeoutMs = OCR_TIMEOUT_MS;
  const loteTamanho = posInt(config?.loteTamanho, pendentes.length);
  const pausaLoteMs = posInt(config?.pausaLoteMs, 0);

  console.log(
    `[lote ${iter}] modo=${MODO} extraindo ${pendentes.length} anexo(s) ` +
      `(OCR=${configExtrator.ocrEstrategia}, lote=${loteTamanho}).`,
  );

  const buffer = [];
  let processados = 0;
  for (const vinculo of pendentes) {
    // No modo OCR, se o Tika morreu/travou, aborta o run antes de queimar o
    // budget em timeouts encadeados. O que ja foi empurrado fica persistido; a
    // fila precisa_ocr guarda o resto para o proximo run.
    if (MODO === "ocr" && !(await tikaVivo())) {
      console.error("[ocr] Tika indisponivel (healthcheck falhou); abortando o run.");
      await drenarBuffer(buffer, 1);
      console.log(`Concluido em ${Date.now() - startedAt}ms. Lotes=${iter}, processados=${totalProcessados + processados}.`);
      console.log("Resumo da extracao:");
      console.log(JSON.stringify(resumo, null, 2));
      process.exit(0);
    }
    const out = await processarVinculo(vinculo, configExtrator);
    buffer.push(out);
    processados += 1;
    const tag = out.ok
      ? (out.precisa_ocr ? "precisa_ocr (enfileirado)" : `ok (${out.texto?.length ?? 0} chars, via=${out.via})`)
      : `ERRO ${out.erro}`;
    console.error(`[extrair ${processados}/${pendentes.length}] vinculo ${vinculo.id}: ${tag}`);
    // Persiste e libera memoria assim que junta um chunk cheio.
    await drenarBuffer(buffer, PUSH_CHUNK);
    if (pausaLoteMs > 0 && processados % loteTamanho === 0) await delay(pausaLoteMs);
  }
  // Empurra o resto que nao completou um chunk.
  await drenarBuffer(buffer, 1);
  totalProcessados += processados;
}

console.log(`Concluido em ${Date.now() - startedAt}ms. Lotes=${iter}, processados=${totalProcessados}.`);
console.log("Resumo da extracao:");
console.log(JSON.stringify(resumo, null, 2));
process.exit(0);
