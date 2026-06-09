// =====================================================================
// .github/scripts/diag-drive.mjs
// DIAGNOSTICO (somente leitura) de uma pasta do Drive. NAO enfileira nada,
// NAO extrai, NAO toca no banco. So lista a arvore e imprime um PERFIL:
//   - total de arquivos baixaveis (e quantos Google Docs nativos pulados)
//   - quebra por EXTENSAO
//   - quebra por SUBPASTA de 1o nivel (onde mora o volume)
//   - amostra de nomes
// Uso: descobrir POR QUE uma pasta "piloto" trouxe N arquivos inesperados.
//
// Env (secrets do Actions): GOOGLE_OAUTH_CLIENT_ID/_SECRET/_REFRESH_TOKEN
//                           DRIVE_FOLDER_ID
// =====================================================================

import { getDriveAccessToken, extensaoDoNome } from "./drive.mjs";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FOLDER_ID = (process.env.DRIVE_FOLDER_ID ?? "").trim();

if (!FOLDER_ID) {
  console.error("ERRO: env DRIVE_FOLDER_ID ausente.");
  process.exit(2);
}

let nativosPulados = 0;

// Lista os filhos imediatos (arquivos + subpastas) de uma pasta.
async function listarFilhos(folderId, token) {
  const arquivos = [];
  const subpastas = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`${DRIVE_API}/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`files.list falhou (${res.status}): ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    for (const f of json.files ?? []) {
      if (f.mimeType === FOLDER_MIME) subpastas.push({ id: f.id, nome: f.name });
      else if (typeof f.mimeType === "string" && f.mimeType.startsWith(GOOGLE_NATIVE_PREFIX))
        nativosPulados++;
      else
        arquivos.push({
          nome: f.name,
          mimeType: f.mimeType ?? null,
          ext: extensaoDoNome(f.name),
          tamanho: f.size != null ? Number(f.size) : null,
        });
    }
    pageToken = json.nextPageToken ?? null;
  } while (pageToken);
  return { arquivos, subpastas };
}

// Conta recursivamente todos os arquivos baixaveis abaixo de uma pasta,
// acumulando no agregado global e devolvendo o total local.
async function contarRecursivo(folderId, token, agregado, vistos) {
  if (vistos.has(folderId)) return 0;
  vistos.add(folderId);
  const { arquivos, subpastas } = await listarFilhos(folderId, token);
  let total = arquivos.length;
  for (const a of arquivos) {
    const k = a.ext || "(sem extensao)";
    agregado.ext.set(k, (agregado.ext.get(k) || 0) + 1);
    if (agregado.amostra.length < 30) agregado.amostra.push(a.nome);
    agregado.bytes += a.tamanho || 0;
  }
  for (const sub of subpastas) total += await contarRecursivo(sub.id, token, agregado, vistos);
  return total;
}

async function main() {
  console.log(`Perfilando a pasta do Drive ${FOLDER_ID} (recursivo, somente leitura)...`);
  const token = await getDriveAccessToken();

  const agregado = { ext: new Map(), amostra: [], bytes: 0 };
  const vistos = new Set();

  // Nivel 0: filhos imediatos -> arquivos soltos + subpastas de 1o nivel.
  const raiz = await listarFilhos(FOLDER_ID, token);
  vistos.add(FOLDER_ID);

  // Arquivos soltos na raiz entram no agregado.
  for (const a of raiz.arquivos) {
    const k = a.ext || "(sem extensao)";
    agregado.ext.set(k, (agregado.ext.get(k) || 0) + 1);
    if (agregado.amostra.length < 30) agregado.amostra.push(a.nome);
    agregado.bytes += a.tamanho || 0;
  }

  // Por subpasta de 1o nivel: conta recursivo (e alimenta o agregado global).
  const porSubpasta = [];
  porSubpasta.push({ nome: "(arquivos soltos na raiz)", total: raiz.arquivos.length });
  for (const sub of raiz.subpastas) {
    const n = await contarRecursivo(sub.id, token, agregado, vistos);
    porSubpasta.push({ nome: sub.nome, total: n });
  }

  const totalArquivos = [...agregado.ext.values()].reduce((a, b) => a + b, 0);

  console.log("\n================ PERFIL DA PASTA ================");
  console.log(`Total de arquivos baixaveis: ${totalArquivos}`);
  console.log(`Google Docs nativos pulados (sem download direto): ${nativosPulados}`);
  console.log(`Tamanho total aprox.: ${(agregado.bytes / 1024 / 1024).toFixed(1)} MiB`);

  console.log("\n--- Por EXTENSAO (desc) ---");
  for (const [ext, n] of [...agregado.ext.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(7)}  ${ext}`);
  }

  console.log("\n--- Por SUBPASTA de 1o nivel (desc) ---");
  for (const s of porSubpasta.sort((a, b) => b.total - a.total)) {
    console.log(`  ${String(s.total).padStart(7)}  ${s.nome}`);
  }

  console.log("\n--- Amostra de nomes (ate 30) ---");
  for (const nome of agregado.amostra) console.log(`  ${nome}`);
  console.log("=================================================");
}

main().catch((err) => {
  console.error("ERRO:", err?.message ?? String(err));
  process.exit(1);
});
