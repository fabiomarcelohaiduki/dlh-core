// =====================================================================
// .github/scripts/descobrir-drive.mjs
// DESCOBERTA da fonte 'drive' (camada 1). Roda ANTES do extrair-anexos.mjs:
// para cada pasta ATIVA cadastrada no cockpit, lista o Drive (recursivo),
// monta a lista de arquivos e a empurra ao Edge documentos-descobrir, que
// materializa/atualiza a fila de vinculos.
//
// PASTAS: vem do Edge drive-pastas (action='ativas'), administradas no
// cockpit. DRIVE_FOLDER_ID (input do workflow) e OVERRIDE opcional: quando
// presente, descobre SO aquela pasta (teste pontual), ignorando o cadastro.
//
// POR QUE NO RUNNER (e nao SQL como Nomus/Effecti): a lista de arquivos do
// Drive vive na API do Google, nao no banco. A credencial Drive so existe
// aqui. O Edge so persiste (service_role) — espelha a divisao do projeto.
//
// O extrair-anexos.mjs depois consome a MESMA fila (sem filtro de fonte),
// baixa os bytes pelo adaptador 'drive' e extrai via Tika.
//
// Env obrigatorias:
//   SUPABASE_URL                 https://<ref>.supabase.co
//   CRON_DISPATCH_SECRET         X-Cron-Secret do Edge (drive.mjs troca por um
//                                access_token fresco na Edge drive-oauth; o
//                                segredo do Google vive no Vault, nao aqui)
// Env opcionais:
//   SUPABASE_ANON_KEY            apikey do gateway (incluida quando presente)
//   DRIVE_FOLDER_ID              override: descobre so esta pasta (teste)
// =====================================================================

import { getDriveAccessToken, listarArquivosPasta } from "./drive.mjs";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const CRON_SECRET = process.env.CRON_DISPATCH_SECRET;
const ANON = process.env.SUPABASE_ANON_KEY;
const FOLDER_OVERRIDE = (process.env.DRIVE_FOLDER_ID ?? "").trim();
const LOTE = Number(process.env.DRIVE_DESCOBRIR_LOTE) || 500;

function fail(msg, code = 2) {
  console.error(`ERRO: ${msg}`);
  process.exit(code);
}

if (!SUPABASE_URL) fail("env SUPABASE_URL ausente.");
if (!CRON_SECRET) fail("env CRON_DISPATCH_SECRET ausente.");

const DESCOBRIR_URL = `${SUPABASE_URL}/functions/v1/documentos-descobrir`;
const PASTAS_URL = `${SUPABASE_URL}/functions/v1/drive-pastas`;

function headers() {
  const h = { "Content-Type": "application/json", "X-Cron-Secret": CRON_SECRET };
  if (ANON) {
    h["apikey"] = ANON;
    h["Authorization"] = `Bearer ${ANON}`;
  }
  return h;
}

/** Pastas a descobrir: override (1 pasta) OU as ativas do cockpit. */
async function resolverPastas() {
  if (FOLDER_OVERRIDE) {
    console.log(`Override DRIVE_FOLDER_ID: descobrindo so a pasta ${FOLDER_OVERRIDE}.`);
    return [{ folder_id: FOLDER_OVERRIDE, nome: "(override)" }];
  }
  const res = await fetch(PASTAS_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ action: "ativas" }),
  });
  const text = await res.text();
  if (!res.ok) {
    fail(`drive-pastas (ativas) falhou (${res.status}): ${text.slice(0, 300)}`, 1);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    fail("resposta nao-JSON de drive-pastas.", 1);
  }
  return Array.isArray(json?.pastas) ? json.pastas : [];
}

/** Lista uma pasta e empurra os arquivos ao Edge em lotes. Devolve inseridos. */
async function descobrirPasta(folderId, token) {
  const arquivos = await listarArquivosPasta(folderId, token);
  if (arquivos.length === 0) {
    console.log("  nenhum arquivo baixavel (pasta vazia ou so Google Docs nativos).");
    return 0;
  }
  // Enfileira em LOTES: a funcao descobrir_vinculos_drive faz N inserts numa
  // transacao, e uma pasta grande num unico POST estoura o timeout do gateway
  // (504). O RPC e idempotente por file_id, entao fatiar e seguro e re-tentavel.
  let inseridos = 0;
  for (let i = 0; i < arquivos.length; i += LOTE) {
    const lote = arquivos.slice(i, i + LOTE);
    const res = await fetch(DESCOBRIR_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ fonte: "drive", arquivos: lote }),
    });
    const text = await res.text();
    if (!res.ok) {
      fail(`documentos-descobrir falhou no lote ${i / LOTE + 1} (${res.status}): ${text.slice(0, 300)}`, 1);
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      // mantem text cru.
    }
    const n = Number(json?.inseridos);
    if (Number.isFinite(n)) inseridos += n;
    console.log(`  lote ${i / LOTE + 1}: ${lote.length} arquivo(s) -> novos/reabertos ${json?.inseridos ?? "?"}`);
  }
  return inseridos;
}

async function main() {
  const pastas = await resolverPastas();
  if (pastas.length === 0) {
    console.log("Nenhuma pasta do Drive ativa cadastrada. Nada a descobrir.");
    return;
  }

  console.log(`${pastas.length} pasta(s) do Drive a descobrir.`);
  const token = await getDriveAccessToken();
  let totalInseridos = 0;
  for (const p of pastas) {
    const folderId = (p.folder_id ?? "").trim();
    if (!folderId) continue;
    console.log(`Pasta "${p.nome ?? folderId}" (${folderId})...`);
    totalInseridos += await descobrirPasta(folderId, token);
  }
  console.log(`Descoberta Drive concluida. Total vinculos novos/reabertos: ${totalInseridos}.`);
}

main().catch((err) => fail(err?.message ?? String(err), 1));
