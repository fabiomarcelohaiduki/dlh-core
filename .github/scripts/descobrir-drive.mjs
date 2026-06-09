// =====================================================================
// .github/scripts/descobrir-drive.mjs
// DESCOBERTA da fonte 'drive' (camada 1). Roda ANTES do extrair-anexos.mjs:
// lista a pasta do Drive (recursivo), monta a lista de arquivos e a empurra
// ao Edge documentos-descobrir, que materializa/atualiza a fila de vinculos.
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
//   CRON_DISPATCH_SECRET         X-Cron-Secret do Edge
//   DRIVE_FOLDER_ID              id da pasta-piloto (input do workflow)
//   GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN   (lidos por drive.mjs)
// Env opcionais:
//   SUPABASE_ANON_KEY            apikey do gateway (incluida quando presente)
// =====================================================================

import { getDriveAccessToken, listarArquivosPasta } from "./drive.mjs";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const CRON_SECRET = process.env.CRON_DISPATCH_SECRET;
const ANON = process.env.SUPABASE_ANON_KEY;
const FOLDER_ID = (process.env.DRIVE_FOLDER_ID ?? "").trim();

function fail(msg, code = 2) {
  console.error(`ERRO: ${msg}`);
  process.exit(code);
}

if (!SUPABASE_URL) fail("env SUPABASE_URL ausente.");
if (!CRON_SECRET) fail("env CRON_DISPATCH_SECRET ausente.");
if (!FOLDER_ID) fail("env DRIVE_FOLDER_ID ausente (informe a pasta-piloto no disparo).");

const DESCOBRIR_URL = `${SUPABASE_URL}/functions/v1/documentos-descobrir`;

function headers() {
  const h = { "Content-Type": "application/json", "X-Cron-Secret": CRON_SECRET };
  if (ANON) {
    h["apikey"] = ANON;
    h["Authorization"] = `Bearer ${ANON}`;
  }
  return h;
}

async function main() {
  console.log(`Listando a pasta do Drive ${FOLDER_ID} (recursivo)...`);
  const token = await getDriveAccessToken();
  const arquivos = await listarArquivosPasta(FOLDER_ID, token);

  if (arquivos.length === 0) {
    console.log("Nenhum arquivo baixavel encontrado na pasta (vazia ou so Google Docs nativos).");
    return;
  }
  console.log(`Encontrados ${arquivos.length} arquivo(s) baixavel(is). Enviando ao Edge...`);

  const res = await fetch(DESCOBRIR_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ fonte: "drive", arquivos }),
  });
  const text = await res.text();
  if (!res.ok) fail(`documentos-descobrir falhou (${res.status}): ${text.slice(0, 300)}`, 1);

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    // mantem text cru.
  }
  console.log(`Descoberta Drive concluida. Vinculos novos/reabertos: ${json?.inseridos ?? "?"}.`);
}

main().catch((err) => fail(err?.message ?? String(err), 1));
