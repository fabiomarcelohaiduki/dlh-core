// Fase 0 (validacao): prova se um runner de NUVEM (GitHub Actions, runtime Node
// com OpenSSL) consegue conectar no Nomus. Confirma de uma vez:
//   1) TLS — Node/OpenSSL aceita a cifra CBC legada que o Deno/Edge recusava;
//   2) IP  — o egress do GitHub Actions nao e bloqueado pelo Nomus.
// Faz UMA chamada e reporta status + amostra. NAO grava nada.

const KEY = process.env.NOMUS_API_KEY;
const BASE =
  process.env.NOMUS_BASE_URL ?? "https://famaha.nomus.com.br/famaha";

if (!KEY) {
  console.error("ERRO: secret NOMUS_API_KEY ausente.");
  process.exit(2);
}

const url = `${BASE}/rest/processos?pagina=1`;
const startedAt = Date.now();

try {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  const latencia = Date.now() - startedAt;
  const text = await res.text();
  let qtd = "n/a";
  try {
    const json = JSON.parse(text);
    qtd = Array.isArray(json) ? String(json.length) : "(nao-array)";
  } catch (_) {
    qtd = "(body nao-JSON)";
  }
  console.log(
    JSON.stringify(
      {
        resultado: res.ok ? "CONECTOU" : "RESPONDEU_MAS_NAO_OK",
        status: res.status,
        latenciaMs: latencia,
        itensNaPagina: qtd,
        amostra: text.slice(0, 200),
      },
      null,
      2,
    ),
  );
  process.exit(res.ok ? 0 : 1);
} catch (err) {
  const latencia = Date.now() - startedAt;
  console.error(
    JSON.stringify(
      {
        resultado: "FALHOU",
        latenciaMs: latencia,
        name: err?.name ?? null,
        message: err?.message ?? String(err),
        cause: err?.cause ? String(err.cause?.message ?? err.cause) : null,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
