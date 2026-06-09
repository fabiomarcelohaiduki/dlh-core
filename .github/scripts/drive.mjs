// =====================================================================
// .github/scripts/drive.mjs
// Cliente Google Drive para o runner do Actions (fonte 'drive' do pipeline
// de documentos camada 1). E so mais um ADAPTADOR de obtencao de bytes: o
// documento e cidadao de 1a classe, a fonte e detalhe. Reusado por:
//   - descobrir-drive.mjs : lista a pasta e enfileira vinculos no Edge;
//   - extrair-anexos.mjs  : baixa os bytes de cada vinculo pendente.
//
// AUTH (headless, decisao Fabio 2026-06-08 = opcao A): o runner NAO faz
// login interativo. Usa um REFRESH TOKEN de uso prolongado (gerado uma vez
// pelo Client Desktop via gerar-token-drive.mjs) e o troca por um
// access_token de curta duracao a cada necessidade. Escopo drive.readonly
// (minimo privilegio: so listar e baixar).
//
// Env (secrets do Actions):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN
//
// Modulo SEM efeitos no top-level: as envs so sao exigidas quando uma funcao
// que fala com o Google e de fato chamada (runs sem Drive nao quebram).
// =====================================================================

const TOKEN_URL = "https://oauth2.googleapis.com/token";
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
 * Troca o refresh_token por um access_token, com cache. Re-usa o token em
 * cache enquanto valido; renova quando perto de expirar ou forcado.
 */
export async function getDriveAccessToken({ force = false } = {}) {
  if (!force && _cache.token && Date.now() < _cache.exp - EXP_MARGIN_MS) {
    return _cache.token;
  }
  const body = new URLSearchParams({
    client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    refresh_token: requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`falha ao renovar access_token do Drive (${res.status}): ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error("resposta nao-JSON do endpoint de token do Google");
  }
  const token = json.access_token;
  const expiresIn = Number(json.expires_in) || 3600;
  if (!token) throw new Error("endpoint de token nao devolveu access_token");
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
