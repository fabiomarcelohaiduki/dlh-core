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
//   EXTRACAO_LIMITE        teto de vinculos por run (default = config.loteTamanho ou 50)
//   EXTRACAO_PUSH_CHUNK    resultados por push ao Edge (default 3; texto e pesado)

import { extrairTexto, ExtracaoError } from "./extrator.mjs";

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

function posInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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

/** Pede vinculos pendentes + config_extracao ao Edge. */
async function fetchPendentes(limite) {
  const r = await postEdge({ action: "pendentes", ...(limite ? { limite } : {}) });
  if (!r.ok) fail(`falha ao listar pendentes (${r.status}): ${r.text.slice(0, 300)}`, 1);
  return { pendentes: r.json?.pendentes ?? [], config: r.json?.config ?? null };
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
 * Effecti: a URL do anexo e publica e nao expira (CDN content-addressed do
 * Compras Publicas; ComprasNet via middleware pode exigir token Effecti -
 * tratar quando exercido). Re-fetchavel por demanda.
 */
async function obterBytesEffecti(ref) {
  const url = ref?.url;
  if (!url) throw new Error("ref_obtencao.url ausente (effecti)");
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`download Effecti falhou (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const nomeArquivo = ref?.nome
    ?? decodeURIComponent(String(url).split("/").pop()?.split("?")[0] || "anexo");
  return { bytes, nomeArquivo, extensao: ref?.extensao ?? null };
}

const ADAPTADORES = {
  nomus: obterBytesNomus,
  effecti: obterBytesEffecti,
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
    return { vinculo_id: vinculo.id, ok: false, erro: `${code}${err?.message ?? err}` };
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
// Push dos resultados ao Edge (em lotes; texto e pesado).
// ---------------------------------------------------------------------

async function pushResultados(resultados) {
  const acc = { recebidos: 0, novos: 0, herdados: 0, erros: 0 };
  for (let i = 0; i < resultados.length; i += PUSH_CHUNK) {
    const lote = resultados.slice(i, i + PUSH_CHUNK);
    const r = await postEdge({ documentos: lote });
    if (!r.ok) fail(`push de resultados falhou (${r.status}): ${r.text.slice(0, 300)}`, 1);
    acc.recebidos += r.json?.recebidos ?? lote.length;
    acc.novos += r.json?.novos ?? 0;
    acc.herdados += r.json?.herdados ?? 0;
    acc.erros += r.json?.erros ?? 0;
    console.error(
      `[push ${i / PUSH_CHUNK + 1}] enviados ${lote.length} | ` +
        `acum novos=${acc.novos} herdados=${acc.herdados} erros=${acc.erros}`,
    );
  }
  return acc;
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

const startedAt = Date.now();

const limiteEnv = posInt(process.env.EXTRACAO_LIMITE, 0) || undefined;
const { pendentes, config } = await fetchPendentes(limiteEnv);

if (pendentes.length === 0) {
  console.log("Nenhum vinculo pendente de extracao.");
  process.exit(0);
}

const configExtrator = montarConfigExtrator(config);
const loteTamanho = posInt(config?.loteTamanho, pendentes.length);
const pausaLoteMs = posInt(config?.pausaLoteMs, 0);

console.log(
  `Extraindo ${pendentes.length} anexo(s) pendentes ` +
    `(OCR=${configExtrator.ocrEstrategia ?? "padrao"}, lote=${loteTamanho}).`,
);

const resultados = [];
let processados = 0;
for (const vinculo of pendentes) {
  const out = await processarVinculo(vinculo, configExtrator);
  resultados.push(out);
  processados += 1;
  const tag = out.ok ? `ok (${out.texto?.length ?? 0} chars, via=${out.via})` : `ERRO ${out.erro}`;
  console.error(`[extrair ${processados}/${pendentes.length}] vinculo ${vinculo.id}: ${tag}`);
  if (pausaLoteMs > 0 && processados % loteTamanho === 0) await delay(pausaLoteMs);
}

const resumo = await pushResultados(resultados);

console.log(`Concluido em ${Date.now() - startedAt}ms.`);
console.log("Resumo da extracao:");
console.log(JSON.stringify(resumo, null, 2));
process.exit(0);
