// =====================================================================
// .github/scripts/drive.mjs
// Cliente Google Drive para o runner do Actions (fonte 'drive' do pipeline
// de documentos camada 1). E so mais um ADAPTADOR de obtencao de bytes: o
// documento e cidadao de 1a classe, a fonte e detalhe. Reusado por:
//   - descobrir-drive.mjs : lista a pasta e enfileira vinculos no Edge;
//   - extrair-anexos.mjs  : baixa os bytes de cada vinculo pendente.
//
// AUTH (decisao Fabio 2026-06-09): a conta do Drive e conectada PELO COCKPIT
// (botao "Conectar Google"). O refresh_token vive CIFRADO no Vault do
// Supabase; o runner NAO guarda mais segredos do Google. Para obter um
// access_token de curta duracao ele chama a Edge drive-oauth
// (action='access-token') com o X-Cron-Secret — a Edge faz a troca com o
// refresh do Vault e devolve so o access_token. Escopo drive.readonly.
//
// Env (secrets do Actions, ja existentes para os demais runners):
//   SUPABASE_URL                 https://<ref>.supabase.co
//   CRON_DISPATCH_SECRET         X-Cron-Secret do Edge
//   SUPABASE_ANON_KEY            apikey do gateway (opcional, incluida se presente)
//
// Modulo SEM efeitos no top-level: as envs so sao exigidas quando uma funcao
// que fala com o Drive e de fato chamada (runs sem Drive nao quebram).
// =====================================================================

const DRIVE_API = "https://www.googleapis.com/drive/v3";

// MIME types nativos do Google (Docs/Sheets/Slides): NAO tem md5Checksum nem
// download direto via alt=media (precisariam files.export). Adiados no piloto.
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps";
const FOLDER_MIME = "application/vnd.google-apps.folder";

// Cache do access_token (vale ~1h; re-troca quando faltar < margem ou em 401).
let _cache = { token: null, exp: 0 };
const EXP_MARGIN_MS = 60_000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`env ${name} ausente (necessaria para o adaptador drive)`);
  }
  return v.trim();
}

/**
 * Obtem um access_token do Drive pedindo a Edge drive-oauth (action=
 * 'access-token'), que faz a troca com o refresh_token do Vault. O runner so
 * tem anon + X-Cron-Secret; o segredo do Google nunca passa por aqui. Mantem
 * o cache: re-usa enquanto valido, renova perto de expirar ou se forcado.
 */
export async function getDriveAccessToken({ force = false } = {}) {
  if (!force && _cache.token && Date.now() < _cache.exp - EXP_MARGIN_MS) {
    return _cache.token;
  }
  const base = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const cronSecret = requireEnv("CRON_DISPATCH_SECRET");
  const anon = process.env.SUPABASE_ANON_KEY?.trim();

  const headers = {
    "Content-Type": "application/json",
    "X-Cron-Secret": cronSecret,
  };
  if (anon) {
    headers["apikey"] = anon;
    headers["Authorization"] = `Bearer ${anon}`;
  }

  const res = await fetch(`${base}/functions/v1/drive-oauth`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "access-token" }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`drive-oauth access-token falhou (${res.status}): ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error("resposta nao-JSON da Edge drive-oauth");
  }
  const token = json.accessToken;
  const expiresIn = Number(json.expiresIn) || 3600;
  if (!token) throw new Error("drive-oauth nao devolveu accessToken");
  _cache = { token, exp: Date.now() + expiresIn * 1000 };
  return token;
}

/** Assinatura de versao de um arquivo do Drive (decisao Fabio: arquivos mudam).
 *  md5Checksum (binarios) e o sinal forte; modifiedTime cobre o resto. So
 *  re-extrai quando isto muda -> re-rodar a pasta nao re-baixa o inalterado. */
export function assinaturaVersao(file) {
  return file.md5Checksum || file.modifiedTime || null;
}

/** Extensao normalizada (sem ponto, minuscula) derivada do nome. */
export function extensaoDoNome(nome) {
  if (!nome) return null;
  const m = /\.([^.\\/]+)$/.exec(nome);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Lista RECURSIVAMENTE os arquivos de uma pasta do Drive (entra em subpastas).
 * Pula os Google Docs nativos (sem md5/download direto; adiados no piloto) e
 * devolve metadados leves — NAO baixa bytes.
 *
 * @returns {Promise<Array<{file_id, nome, mimeType, extensao, tamanho, assinatura}>>}
 */
export async function listarArquivosPasta(folderId, token, { _vistos = new Set() } = {}) {
  if (_vistos.has(folderId)) return []; // guarda contra atalhos ciclicos
  _vistos.add(folderId);

  const arquivos = [];
  const subpastas = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, size)",
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
      throw new Error(`Drive files.list falhou (${res.status}): ${t.slice(0, 300)}`);
    }
    const json = await res.json();
    for (const f of json.files ?? []) {
      if (f.mimeType === FOLDER_MIME) {
        subpastas.push(f.id);
        continue;
      }
      if (typeof f.mimeType === "string" && f.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
        // Google Doc nativo: sem download direto. Adiado (files.export futuro).
        console.error(`[drive] pulando Google Doc nativo (sem download direto): ${f.name}`);
        continue;
      }
      arquivos.push({
        file_id: f.id,
        nome: f.name,
        mimeType: f.mimeType ?? null,
        extensao: extensaoDoNome(f.name),
        tamanho: f.size != null ? Number(f.size) : null,
        assinatura: assinaturaVersao(f),
      });
    }
    pageToken = json.nextPageToken ?? null;
  } while (pageToken);

  for (const sub of subpastas) {
    const filhos = await listarArquivosPasta(sub, token, { _vistos });
    arquivos.push(...filhos);
  }
  return arquivos;
}

/**
 * Baixa os bytes de um arquivo do Drive (alt=media). Renova o token uma vez
 * em caso de 401 (token expirado entre operacoes longas).
 */
export async function baixarArquivoDrive(fileId, token) {
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    const novo = await getDriveAccessToken({ force: true });
    res = await fetch(url, { headers: { Authorization: `Bearer ${novo}` } });
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`download Drive falhou (${res.status}): ${t.slice(0, 200)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
