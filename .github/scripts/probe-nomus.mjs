// Probe (investigacao): descobre se a API do Nomus aceita algum parametro que
// OMITA os anexos base64 da listagem GET /rest/processos. O base64 inline
// (~2,6 MB/processo de Venda Governamental) e o gargalo do backfill: ~72 GB por
// varredura dos 29k processos. Se algum parametro devolver a listagem SEM o
// base64, o resync diario completo volta a ser viavel.
//
// Estrategia: bate na pagina 1 (que tem processos com anexo) com varias
// variantes de query e compara o tamanho do payload + presenca de
// "anexoBase64". Variante MUITO menor e sem "anexoBase64" = parametro vencedor.
// NAO grava nada. Disparo manual via workflow.

const KEY = process.env.NOMUS_API_KEY;
const BASE = (process.env.NOMUS_BASE_URL ?? "https://famaha.nomus.com.br/famaha").replace(/\/+$/, "");

if (!KEY) {
  console.error("ERRO: secret NOMUS_API_KEY ausente.");
  process.exit(2);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Variantes de parametro a testar (chutes comuns + nomenclatura observada na
// API). A pagina 1 e a base; cada variante adiciona 1 parametro.
const VARIANTES = [
  "pagina=1", // baseline
  "pagina=1&incluirAnexos=false",
  "pagina=1&incluirArquivos=false",
  "pagina=1&incluirAnexoBase64=false",
  "pagina=1&anexos=false",
  "pagina=1&base64=false",
  "pagina=1&arquivosAnexos=false",
  "pagina=1&detalhado=false",
  "pagina=1&resumido=true",
  "pagina=1&campos=id",
  "pagina=1&fields=id",
];

/** Le {tempoAteLiberar:<seg>} do corpo (rate limit do Nomus). null se ausente. */
function peekTempo(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && !Array.isArray(j) && typeof j.tempoAteLiberar === "number") {
      return j.tempoAteLiberar * 1000;
    }
  } catch (_) {
    /* corpo nao-JSON */
  }
  return null;
}

async function bater(query) {
  const url = `${BASE}/rest/processos?${query}`;
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const t0 = Date.now();
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Basic ${KEY}`, Accept: "application/json" },
    });
    const text = await res.text();
    const latenciaMs = Date.now() - t0;

    const tempo = peekTempo(text);
    if (tempo !== null) {
      console.error(`[rate limit] ${query}: aguardando ${tempo}ms`);
      await delay(tempo + 1000);
      continue;
    }

    const bytes = Buffer.byteLength(text, "utf8");
    const ocorrenciasBase64 = (text.match(/anexoBase64/g) || []).length;
    let itens = "n/a";
    try {
      const json = JSON.parse(text);
      itens = Array.isArray(json) ? json.length : "(nao-array)";
    } catch (_) {
      itens = "(nao-JSON)";
    }
    return {
      query,
      status: res.status,
      latenciaMs,
      bytes,
      kib: Math.round(bytes / 1024),
      itens,
      temBase64: ocorrenciasBase64 > 0,
      ocorrenciasBase64,
      amostra: ocorrenciasBase64 === 0 ? text.slice(0, 160) : undefined,
    };
  }
  return { query, status: "RATE_LIMIT_PERSISTENTE" };
}

const resultados = [];
let baselineBytes = null;
for (const v of VARIANTES) {
  const r = await bater(v);
  if (baselineBytes === null && typeof r.bytes === "number") baselineBytes = r.bytes;
  r.vsBaselinePct = (baselineBytes && typeof r.bytes === "number")
    ? Math.round((r.bytes / baselineBytes) * 100)
    : null;
  resultados.push(r);
  console.error(
    `${v} -> status ${r.status} | ${r.kib ?? "?"} KiB (${r.vsBaselinePct ?? "?"}% do baseline) | ` +
      `itens ${r.itens ?? "?"} | base64=${r.temBase64 ?? "?"} (${r.ocorrenciasBase64 ?? "?"})`,
  );
  await delay(1500); // espacar p/ nao provocar throttle.
}

// Veredito: alguma variante menor que ~50% do baseline e SEM base64?
const vencedoras = resultados.filter(
  (r) => typeof r.bytes === "number" && r.temBase64 === false && (r.vsBaselinePct ?? 100) < 50,
);

console.log(JSON.stringify({
  baselineKiB: baselineBytes ? Math.round(baselineBytes / 1024) : null,
  vencedoras: vencedoras.map((r) => r.query),
  veredito: vencedoras.length
    ? "ACHOU parametro(s) que omitem o base64 — usar no coletor"
    : "NENHUM parametro testado omite o base64 — gargalo confirmado, partir p/ fatiar",
  resultados,
}, null, 2));
process.exit(0);
