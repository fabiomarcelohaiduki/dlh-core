// =====================================================================
// .github/scripts/gmail.mjs
// Cliente Gmail para o runner do Actions (fonte 'gmail' do pipeline de
// documentos camada 1). E so mais um ADAPTADOR de obtencao de bytes: o
// documento e cidadao de 1a classe, a fonte e detalhe. Reusado por:
//   - descobrir-gmail.mjs : lista as mensagens (query) e enfileira vinculos;
//   - extrair-anexos.mjs  : obtem os bytes de cada vinculo pendente
//                           (corpo do email OU anexo).
//
// COLETA POR MENSAGEM (decisao Fabio 2026-06-09): cada email rende ate dois
// tipos de vinculo na MESMA fila — 'corpo' (texto da mensagem, ja SEM o
// trecho citado da thread) e 'anexo' (cada arquivo anexado). O thread_id e
// guardado para reconstruir a conversa depois, sem virar unidade de extracao.
//
// AUTH (igual ao Drive, mas conta SEPARADA): a conta do Gmail e conectada
// PELO COCKPIT (botao "Conectar Google" no card Gmail). O refresh_token vive
// CIFRADO no Vault (GMAIL_REFRESH_TOKEN); o runner NAO guarda segredos do
// Google — pede um access_token de curta duracao a Edge gmail-oauth
// (action='access-token') com o X-Cron-Secret. Escopo gmail.readonly.
//
// Env (secrets do Actions, ja existentes para os demais runners):
//   SUPABASE_URL                 https://<ref>.supabase.co
//   CRON_DISPATCH_SECRET         X-Cron-Secret do Edge
//   SUPABASE_ANON_KEY            apikey do gateway (opcional, incluida se presente)
//
// Modulo SEM efeitos no top-level: as envs so sao exigidas quando uma funcao
// que fala com o Gmail e de fato chamada (runs sem Gmail nao quebram).
// =====================================================================

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Nome deterministico do vinculo de corpo (distingue do anexo na fila, que usa
// o filename real). A unique key da fila e (fonte, message_id, nome_anexo).
export const NOME_CORPO = "(corpo).txt";

// Cache do access_token (vale ~1h; re-troca quando faltar < margem ou em 401).
let _cache = { token: null, exp: 0 };
const EXP_MARGIN_MS = 60_000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`env ${name} ausente (necessaria para o adaptador gmail)`);
  }
  return v.trim();
}

/**
 * Obtem um access_token do Gmail pedindo a Edge gmail-oauth (action=
 * 'access-token'), que faz a troca com o refresh_token do Vault. O runner so
 * tem anon + X-Cron-Secret; o segredo do Google nunca passa por aqui.
 */
export async function getGmailAccessToken({ force = false } = {}) {
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

  const res = await fetch(`${base}/functions/v1/gmail-oauth`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "access-token" }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`gmail-oauth access-token falhou (${res.status}): ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error("resposta nao-JSON da Edge gmail-oauth");
  }
  const token = json.accessToken;
  const expiresIn = Number(json.expiresIn) || 3600;
  if (!token) throw new Error("gmail-oauth nao devolveu accessToken");
  _cache = { token, exp: Date.now() + expiresIn * 1000 };
  return token;
}

/** GET autenticado no Gmail, renovando o token uma vez em caso de 401. */
async function gmailGet(path) {
  let token = await getGmailAccessToken();
  let res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    token = await getGmailAccessToken({ force: true });
    res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gmail GET ${path.split("?")[0]} falhou (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Lista as mensagens que casam a query (messages.list, q=...). Pagina ate o
 * fim ou ate `max`. Devolve ids leves [{id, threadId}] — NAO baixa o conteudo.
 */
export async function listarMensagens(query, { max = Infinity } = {}) {
  const ids = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ maxResults: "500" });
    if (query) params.set("q", query);
    if (pageToken) params.set("pageToken", pageToken);
    const json = await gmailGet(`/messages?${params}`);
    for (const m of json.messages ?? []) {
      ids.push({ id: m.id, threadId: m.threadId });
      if (ids.length >= max) return ids;
    }
    pageToken = json.nextPageToken ?? null;
  } while (pageToken);
  return ids;
}

/** Busca uma mensagem completa (format=full traz o payload MIME inteiro). */
export async function obterMensagem(messageId) {
  return gmailGet(`/messages/${encodeURIComponent(messageId)}?format=full`);
}

// ---------------------------------------------------------------------
// Parsing do payload MIME
// ---------------------------------------------------------------------

/** Decodifica base64url (formato do Gmail) em bytes. */
function decodeB64Url(data) {
  return new Uint8Array(Buffer.from(data, "base64url"));
}

/** base64url -> string UTF-8. */
function decodeB64UrlText(data) {
  return Buffer.from(data, "base64url").toString("utf-8");
}

/** Extensao normalizada (sem ponto, minuscula) derivada do nome. */
export function extensaoDoNome(nome) {
  if (!nome) return null;
  const m = /\.([^.\\/]+)$/.exec(nome);
  return m ? m[1].toLowerCase() : null;
}

/** Strip leve de tags HTML para um fallback de corpo so-HTML. */
function htmlParaTexto(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Remove o trecho CITADO de uma resposta (decisao Fabio 2026-06-09): numa
 * thread, cada resposta cola o email anterior embaixo. Sem cortar, o corpo
 * infla com texto repetido e o dedup por hash nao pega. Corta no primeiro
 * marcador de citacao e descarta as linhas com '>'. Heuristica deliberadamente
 * conservadora (pt/en + Outlook); refinavel depois sem mexer no pipeline.
 */
export function striparCitacao(texto) {
  if (!texto) return "";
  const linhas = texto.split(/\r?\n/);
  const out = [];
  // Marcadores de inicio do bloco citado (a partir daqui, descarta o resto).
  const marcadores = [
    /^\s*Em\s.+escreveu:\s*$/i,                       // Gmail pt: "Em <data> <fulano> escreveu:"
    /^\s*On\s.+wrote:\s*$/i,                           // Gmail en: "On <date> <someone> wrote:"
    /^\s*-{2,}\s*Mensagem (original|encaminhada)\s*-{2,}/i, // Outlook pt
    /^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i,    // Outlook en
    /^\s*_{5,}\s*$/,                                   // divisor "______" do Outlook
    /^\s*De:\s.+/i,                                    // bloco de cabecalho citado (pt)
    /^\s*From:\s.+/i,                                  // bloco de cabecalho citado (en)
  ];
  for (const linha of linhas) {
    if (marcadores.some((re) => re.test(linha))) break; // inicio da citacao: para aqui
    if (/^\s*>/.test(linha)) continue;                  // linha citada solta: pula
    out.push(linha);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Caminha o payload MIME coletando: melhor corpo (text/plain preferido, senao
 * text/html convertido) e os anexos (parts com filename + attachmentId).
 */
function caminharPartes(payload, acc) {
  if (!payload) return;
  const mime = payload.mimeType ?? "";
  const filename = payload.filename ?? "";
  const body = payload.body ?? {};

  // Anexo: tem nome de arquivo e um attachmentId (bytes buscados a parte).
  if (filename && body.attachmentId) {
    acc.anexos.push({
      attachment_id: body.attachmentId,
      nome: filename,
      mimeType: mime || null,
      extensao: extensaoDoNome(filename),
      tamanho: typeof body.size === "number" ? body.size : null,
    });
  } else if (mime === "text/plain" && body.data && !acc.plain) {
    acc.plain = decodeB64UrlText(body.data);
  } else if (mime === "text/html" && body.data && !acc.html) {
    acc.html = decodeB64UrlText(body.data);
  }

  for (const parte of payload.parts ?? []) {
    caminharPartes(parte, acc);
  }
}

/**
 * Extrai o conteudo util de uma mensagem: thread_id, corpo limpo (sem citacao)
 * e a lista de anexos. O corpo prefere text/plain; cai para html convertido.
 */
export function extrairConteudo(message) {
  const acc = { plain: "", html: "", anexos: [] };
  caminharPartes(message?.payload, acc);
  const bruto = acc.plain || (acc.html ? htmlParaTexto(acc.html) : "");
  const corpo = striparCitacao(bruto);
  return {
    threadId: message?.threadId ?? null,
    corpo,
    anexos: acc.anexos,
  };
}

/** Baixa os bytes de um anexo (messages.attachments.get -> base64url). */
export async function baixarAnexo(messageId, attachmentId) {
  const json = await gmailGet(
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  if (!json?.data) {
    throw new Error(`anexo ${attachmentId} sem data na mensagem ${messageId}`);
  }
  return decodeB64Url(json.data);
}
