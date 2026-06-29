// =====================================================================
// Edge Function: gmail-coletar  ->  POST /gmail-coletar
// DESCOBERTA da fonte 'gmail' (camada 1) rodando DENTRO do Supabase (Edge
// Deno), no lugar do runner Node do GitHub Actions. Porta direta do
// .github/scripts/descobrir-gmail.mjs: monta a query (gmail-config), lista as
// mensagens na API do Google, e para cada uma enfileira na fila de documentos
// um item 'corpo' + N 'anexo' (via documentos-descobrir). NAO baixa bytes e
// NAO usa Tika -> leve. A extracao (Tika) segue separada.
//
// POR QUE SAIU DO GITHUB ACTIONS: o OAuth do Gmail ja vive cifrado no Vault
// (a Edge gmail-oauth troca o refresh por um access_token); a coleta so
// precisa do access_token + da API REST do Google, ambos alcancaveis daqui.
// Com o billing do Actions bloqueando os runs, a coleta migra para o mesmo
// modelo do Effecti: pg_cron -> Edge nativo.
//
// AUTH: apenas chamador SISTEMA (pg_cron / Edge gmail-disparar) via
// X-Cron-Secret. Sem sessao humana. As Edges irmas (gmail-oauth, gmail-config,
// gmail-execucao, documentos-descobrir) sao reusadas como estao: este Edge so
// orquestra o loop e fala com a API do Google (a unica parte que faltava em Deno).
//
// EXECUCAO EM BACKGROUND: o lock-por-fonte (abrirExecucao) e adquirido SINCRONO
// e o loop pesado (listar + buscar mensagens + enfileirar) roda em
// EdgeRuntime.waitUntil, devolvendo 202 na hora. Assim o pg_net que dispara
// nao espera o loop inteiro (evita timeout) e o lock impede sobreposicao.
//
// Body (opcional, espelha os inputs do antigo workflow_dispatch):
//   gatilho      'manual' | 'agendada' (default 'agendada')
//   gmail_query  override: query Gmail crua para teste pontual de 1 email
//   gmail_max    teto de mensagens varridas no teste (default: sem teto)
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { matchesCronSecret } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { type ColetaLogger, createColetaLogger } from "../_shared/coleta-log.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Nome deterministico do vinculo de corpo (distingue do anexo na fila, que usa
// o filename real). A unique key da fila e (fonte, message_id, nome).
const NOME_CORPO = "(corpo).txt";

// Itens por POST ao documentos-descobrir (mesma fatia do runner).
const LOTE = 500;

/** Contexto de chamada das Edges irmas: base do projeto + cron secret + anon. */
interface ColetaCtx {
  baseUrl: string;
  cronSecret: string;
  anon: string;
}

/** Headers das chamadas internas (X-Cron-Secret + apikey/Authorization anon). */
function internalHeaders(ctx: ColetaCtx): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Cron-Secret": ctx.cronSecret,
    "apikey": ctx.anon,
    "Authorization": `Bearer ${ctx.anon}`,
  };
}

// ---------------------------------------------------------------------
// Cliente Gmail (porta do .github/scripts/gmail.mjs para Deno). Unica
// diferenca real: decode base64url via Web API (atob/TextDecoder) no lugar de
// Buffer do Node.
// ---------------------------------------------------------------------

// Cache do access_token (vale ~1h; re-troca quando faltar < margem ou em 401).
let _tokenCache: { token: string | null; exp: number } = { token: null, exp: 0 };
const EXP_MARGIN_MS = 60_000;

/**
 * Obtem um access_token do Gmail pedindo a Edge gmail-oauth (action=
 * 'access-token'), que faz a troca com o refresh_token do Vault. Daqui so
 * passa o X-Cron-Secret + anon; o segredo do Google nunca trafega.
 */
async function getGmailAccessToken(ctx: ColetaCtx, force = false): Promise<string> {
  if (!force && _tokenCache.token && Date.now() < _tokenCache.exp - EXP_MARGIN_MS) {
    return _tokenCache.token;
  }
  const res = await fetch(`${ctx.baseUrl}/functions/v1/gmail-oauth`, {
    method: "POST",
    headers: internalHeaders(ctx),
    body: JSON.stringify({ action: "access-token" }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`gmail-oauth access-token falhou (${res.status}): ${text.slice(0, 300)}`);
  }
  let json: { accessToken?: string; expiresIn?: number };
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error("resposta nao-JSON da Edge gmail-oauth");
  }
  const token = json.accessToken;
  const expiresIn = Number(json.expiresIn) || 3600;
  if (!token) throw new Error("gmail-oauth nao devolveu accessToken");
  _tokenCache = { token, exp: Date.now() + expiresIn * 1000 };
  return token;
}

/** GET autenticado no Gmail, renovando o token uma vez em caso de 401. */
async function gmailGet(ctx: ColetaCtx, path: string): Promise<Record<string, unknown>> {
  let token = await getGmailAccessToken(ctx);
  let res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    token = await getGmailAccessToken(ctx, true);
    res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gmail GET ${path.split("?")[0]} falhou (${res.status}): ${t.slice(0, 200)}`);
  }
  return await res.json();
}

interface MensagemRef {
  id: string;
  threadId: string | null;
}

/**
 * Lista as mensagens que casam a query (messages.list, q=...). Pagina ate o
 * fim ou ate `max`. Devolve ids leves [{id, threadId}] — NAO baixa o conteudo.
 */
async function listarMensagens(
  ctx: ColetaCtx,
  query: string,
  max: number,
): Promise<MensagemRef[]> {
  const ids: MensagemRef[] = [];
  let pageToken: string | null = null;
  do {
    const params = new URLSearchParams({ maxResults: "500" });
    if (query) params.set("q", query);
    if (pageToken) params.set("pageToken", pageToken);
    const json = await gmailGet(ctx, `/messages?${params}`);
    const mensagens = (json.messages as Array<{ id: string; threadId?: string }> | undefined) ?? [];
    for (const m of mensagens) {
      ids.push({ id: m.id, threadId: m.threadId ?? null });
      if (ids.length >= max) return ids;
    }
    pageToken = (json.nextPageToken as string | undefined) ?? null;
  } while (pageToken);
  return ids;
}

/** Busca uma mensagem completa (format=full traz o payload MIME inteiro). */
function obterMensagem(ctx: ColetaCtx, messageId: string): Promise<Record<string, unknown>> {
  return gmailGet(ctx, `/messages/${encodeURIComponent(messageId)}?format=full`);
}

/** base64url -> string UTF-8 (Web API; substitui Buffer.from('base64url')). */
function decodeB64UrlText(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Extensao normalizada (sem ponto, minuscula) derivada do nome. */
function extensaoDoNome(nome: string | null): string | null {
  if (!nome) return null;
  const m = /\.([^.\\/]+)$/.exec(nome);
  return m ? m[1].toLowerCase() : null;
}

/** Strip leve de tags HTML para um fallback de corpo so-HTML. */
function htmlParaTexto(html: string): string {
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
 * Remove o trecho CITADO de uma resposta: numa thread cada resposta cola o
 * email anterior embaixo. Sem cortar, o corpo infla com texto repetido e o
 * dedup por hash nao pega. Heuristica conservadora (pt/en + Outlook).
 */
function striparCitacao(texto: string): string {
  if (!texto) return "";
  const linhas = texto.split(/\r?\n/);
  const out: string[] = [];
  const marcadores = [
    /^\s*Em\s.+escreveu:\s*$/i,
    /^\s*On\s.+wrote:\s*$/i,
    /^\s*-{2,}\s*Mensagem (original|encaminhada)\s*-{2,}/i,
    /^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i,
    /^\s*_{5,}\s*$/,
    /^\s*De:\s.+/i,
    /^\s*From:\s.+/i,
  ];
  for (const linha of linhas) {
    if (marcadores.some((re) => re.test(linha))) break;
    if (/^\s*>/.test(linha)) continue;
    out.push(linha);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

interface AnexoRef {
  attachment_id: string;
  nome: string;
  extensao: string | null;
}

interface MimePayload {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MimePayload[];
}

/**
 * Le um header do payload MIME de topo, case-insensitive (ex.: "Subject",
 * "From", "To", "Cc", "Date"). Devolve o valor trimado ou null se ausente/vazio.
 */
function lerHeader(message: Record<string, unknown>, nome: string): string | null {
  const payload = message.payload as MimePayload | undefined;
  const alvo = nome.toLowerCase();
  for (const h of payload?.headers ?? []) {
    if ((h.name ?? "").toLowerCase() === alvo) {
      return (h.value ?? "").trim() || null;
    }
  }
  return null;
}

/**
 * Converte o header "Date" (RFC 2822, ex.: "Mon, 29 Jun 2026 16:24:00 -0300")
 * para ISO-8601. Devolve null quando ausente ou nao-parseavel, preservando o
 * contrato null-safe dos demais metadados.
 */
function dataEmailIso(message: Record<string, unknown>): string | null {
  const raw = lerHeader(message, "date");
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Caminha o payload MIME coletando: melhor corpo (text/plain preferido, senao
 * text/html convertido) e os anexos (parts com filename + attachmentId).
 */
function caminharPartes(
  payload: MimePayload | undefined,
  acc: { plain: string; html: string; anexos: AnexoRef[] },
): void {
  if (!payload) return;
  const mime = payload.mimeType ?? "";
  const filename = payload.filename ?? "";
  const body = payload.body ?? {};

  if (filename && body.attachmentId) {
    acc.anexos.push({
      attachment_id: body.attachmentId,
      nome: filename,
      extensao: extensaoDoNome(filename),
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
function extrairConteudo(
  message: Record<string, unknown>,
): { threadId: string | null; corpo: string; anexos: AnexoRef[] } {
  const acc = { plain: "", html: "", anexos: [] as AnexoRef[] };
  caminharPartes(message.payload as MimePayload | undefined, acc);
  const bruto = acc.plain || (acc.html ? htmlParaTexto(acc.html) : "");
  const corpo = striparCitacao(bruto);
  return {
    threadId: (message.threadId as string | undefined) ?? null,
    corpo,
    anexos: acc.anexos,
  };
}

// ---------------------------------------------------------------------
// Itens enfileirados a partir de uma mensagem (corpo + anexos).
// ---------------------------------------------------------------------

interface ItemDescoberta {
  message_id: string;
  thread_id: string | null;
  tipo: "corpo" | "anexo";
  nome: string;
  extensao: string | null;
  attachment_id?: string;
  // Metadados do e-mail (iguais para o corpo e todos os anexos da mesma
  // mensagem, pois vem dos headers MIME de topo). Alimentam o cabecalho da
  // guia Dados: assunto (titulo do registro) + remetente/destinatarios/cc/data.
  assunto: string | null;
  remetente: string | null;
  destinatarios: string | null;
  cc: string | null;
  data_email: string | null;
}

function itensDaMensagem(message: Record<string, unknown>): ItemDescoberta[] {
  const { threadId, corpo, anexos } = extrairConteudo(message);
  // Metadados lidos uma vez por mensagem e propagados a todos os itens.
  const meta = {
    assunto: lerHeader(message, "subject"),
    remetente: lerHeader(message, "from"),
    destinatarios: lerHeader(message, "to"),
    cc: lerHeader(message, "cc"),
    data_email: dataEmailIso(message),
  };
  const itens: ItemDescoberta[] = [];
  const messageId = String(message.id ?? "");
  if (corpo) {
    itens.push({
      message_id: messageId,
      thread_id: threadId,
      tipo: "corpo",
      nome: NOME_CORPO,
      extensao: "txt",
      ...meta,
    });
  }
  for (const a of anexos) {
    if (!a.attachment_id || !a.nome) continue;
    itens.push({
      message_id: messageId,
      thread_id: threadId,
      tipo: "anexo",
      nome: a.nome,
      attachment_id: a.attachment_id,
      extensao: a.extensao,
      ...meta,
    });
  }
  return itens;
}

// ---------------------------------------------------------------------
// Orquestracao (porta do descobrir-gmail.mjs): execucao + query + enfileirar.
// ---------------------------------------------------------------------

/** Resolve a(s) query(s): override do body OU as montadas pelo gmail-config. */
async function resolverQueries(ctx: ColetaCtx, override: string): Promise<string[]> {
  if (override) {
    console.log(`Override gmail_query: usando query crua "${override}".`);
    return [override];
  }
  const res = await fetch(`${ctx.baseUrl}/functions/v1/gmail-config`, {
    method: "POST",
    headers: internalHeaders(ctx),
    body: JSON.stringify({ action: "montar-query" }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`gmail-config (montar-query) falhou (${res.status}): ${text.slice(0, 300)}`);
  }
  let json: { queries?: unknown; query?: unknown };
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error("resposta nao-JSON de gmail-config.");
  }
  let queries = Array.isArray(json.queries)
    ? json.queries.filter((q): q is string => typeof q === "string" && q.trim() !== "").map((q) =>
      q.trim()
    )
    : [];
  if (queries.length === 0 && typeof json.query === "string" && json.query.trim()) {
    queries = [json.query.trim()];
  }
  if (queries.length === 0) throw new Error("gmail-config nao devolveu nenhuma query.");
  queries.forEach((q, i) => console.log(`Query ${i + 1}/${queries.length} do cockpit: "${q}".`));
  return queries;
}

/**
 * Abre a execucao da coleta (via gmail-execucao). Devolve o execucao_id, ou
 * null se a fonte ja estiver coletando (lock-por-fonte) — caso em que aborta
 * sem rodar coleta duplicada.
 */
async function abrirExecucao(ctx: ColetaCtx, gatilho: string): Promise<string | null> {
  const res = await fetch(`${ctx.baseUrl}/functions/v1/gmail-execucao`, {
    method: "POST",
    headers: internalHeaders(ctx),
    body: JSON.stringify({ action: "abrir", gatilho }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`gmail-execucao (abrir) falhou (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as { execucao_id?: string; ja_em_andamento?: boolean };
  if (json.ja_em_andamento) {
    console.log(`Ja ha coleta do Gmail em andamento (execucao ${json.execucao_id}). Abortando.`);
    return null;
  }
  console.log(`Execucao aberta: ${json.execucao_id}.`);
  return json.execucao_id ?? null;
}

/** Fecha a execucao (status final + contagens). Best-effort. */
async function fecharExecucao(
  ctx: ColetaCtx,
  execId: string,
  status: "concluida" | "erro",
  total: number,
  sucesso: number,
  erro: number,
  novos = 0,
): Promise<void> {
  try {
    const res = await fetch(`${ctx.baseUrl}/functions/v1/gmail-execucao`, {
      method: "POST",
      headers: internalHeaders(ctx),
      body: JSON.stringify({ action: "fechar", execucao_id: execId, status, total, sucesso, erro, novos }),
    });
    if (!res.ok) {
      console.error(`AVISO: gmail-execucao (fechar) falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`AVISO: falha ao fechar a execucao: ${(err as Error)?.message ?? err}`);
  }
}

/** Empurra itens ao documentos-descobrir em lotes. Devolve total inserido. */
async function enfileirar(ctx: ColetaCtx, itens: ItemDescoberta[], log: ColetaLogger): Promise<number> {
  let inseridos = 0;
  for (let i = 0; i < itens.length; i += LOTE) {
    const lote = itens.slice(i, i + LOTE);
    const res = await fetch(`${ctx.baseUrl}/functions/v1/documentos-descobrir`, {
      method: "POST",
      headers: internalHeaders(ctx),
      body: JSON.stringify({ fonte: "gmail", itens: lote }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`documentos-descobrir falhou no lote ${i / LOTE + 1} (${res.status}): ${text.slice(0, 300)}`);
    }
    let json: { inseridos?: number } = {};
    try {
      json = JSON.parse(text);
    } catch (_) { /* mantem text cru */ }
    const n = Number(json.inseridos);
    if (Number.isFinite(n)) inseridos += n;
    const linha = `  lote ${i / LOTE + 1}: ${lote.length} item(ns) -> novos ${json.inseridos ?? "?"}`;
    console.log(linha);
    log.info(linha);
  }
  return inseridos;
}

/**
 * Loop completo da descoberta (roda em background apos o lock ser adquirido).
 * Espelha o main() do descobrir-gmail.mjs: lista as queries, varre as
 * mensagens deduplicando por id, monta os itens, enfileira e fecha a execucao.
 */
async function rodarDescoberta(
  ctx: ColetaCtx,
  execId: string,
  override: string,
  max: number,
): Promise<void> {
  // Console ao vivo: as mesmas linhas que vao para o log da Edge passam a
  // alimentar a guia "Logs" da Coleta (vinculadas a esta execucao). Best-effort.
  const log = createColetaLogger(createServiceClient(), { execucaoId: execId, origem: "gmail" });
  try {
    const queries = await resolverQueries(ctx, override);
    const vistos = new Set<string>();
    const mensagens: MensagemRef[] = [];
    for (const q of queries) {
      const lote = await listarMensagens(ctx, q, max);
      for (const m of lote) {
        if (vistos.has(m.id)) continue;
        vistos.add(m.id);
        mensagens.push(m);
        if (mensagens.length >= max) break;
      }
      if (mensagens.length >= max) break;
    }
    if (mensagens.length === 0) {
      console.log("Nenhuma mensagem casou a(s) query(s). Nada a descobrir.");
      log.info("Nenhuma mensagem casou a(s) query(s). Nada a descobrir.");
      await log.flush();
      await fecharExecucao(ctx, execId, "concluida", 0, 0, 0);
      return;
    }
    console.log(`${mensagens.length} mensagem(ns) unica(s) a processar.`);
    log.info(`${mensagens.length} mensagem(ns) unica(s) a processar.`);

    const itens: ItemDescoberta[] = [];
    let processadas = 0;
    let falhas = 0;
    for (const { id } of mensagens) {
      // Tolerancia por mensagem: uma falha transitoria do Gmail nao aborta a
      // coleta inteira; a mensagem reentra na proxima coleta (overlap da janela).
      processadas += 1;
      try {
        const msg = await obterMensagem(ctx, id);
        const novos = itensDaMensagem(msg);
        itens.push(...novos);
        const linha = `[mensagem ${processadas}/${mensagens.length}] ${id}: ${novos.length} item(ns)`;
        console.log(linha);
        log.info(linha);
      } catch (err) {
        falhas += 1;
        const linha =
          `[mensagem ${processadas}/${mensagens.length}] ${id}: FALHA (pulada) -> ${(err as Error)?.message ?? err}`;
        console.error(linha);
        log.erro(linha);
      }
    }

    const inseridos = await enfileirar(ctx, itens, log);
    const fim =
      `Descoberta Gmail concluida. Mensagens=${processadas}, falhas=${falhas}, itens=${itens.length}, novos=${inseridos}.`;
    console.log(fim);
    log.info(fim);
    await log.flush();
    await fecharExecucao(ctx, execId, "concluida", itens.length, itens.length, falhas, inseridos);
  } catch (err) {
    // Fecha a execucao como 'erro' antes de propagar (libera o lock-por-fonte).
    const linha = `ERRO na descoberta Gmail: ${(err as Error)?.message ?? err}`;
    console.error(linha);
    log.erro(linha);
    await log.flush();
    await fecharExecucao(ctx, execId, "erro", 0, 0, 0);
  }
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Apenas chamador SISTEMA (pg_cron / gmail-disparar) via cron secret.
    if (!(await matchesCronSecret(req))) {
      throw new HttpError(401, "cron_unauthorized", "autenticacao interna requerida");
    }

    let input: Record<string, unknown> = {};
    try {
      const raw = await req.text();
      input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch (_) {
      throw new HttpError(400, "invalid_body", "corpo JSON invalido");
    }

    const env = getEnv();
    const ctx: ColetaCtx = {
      baseUrl: env.supabaseUrl.replace(/\/+$/, ""),
      // O cron secret ja foi validado (== Vault); reusa o mesmo para as Edges irmas.
      cronSecret: req.headers.get("X-Cron-Secret")?.trim() ?? "",
      anon: env.anonKey,
    };

    const gatilho = String(input.gatilho ?? "agendada") === "manual" ? "manual" : "agendada";
    const override = String(input.gmail_query ?? "").trim();
    const maxRaw = Number(input.gmail_max);
    const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : Infinity;

    // Lock-por-fonte adquirido SINCRONO: se ja ha coleta, devolve sem agendar.
    const execId = await abrirExecucao(ctx, gatilho);
    if (execId === null) {
      return jsonResponse({ ok: true, ja_em_andamento: true }, 200);
    }

    // O loop pesado roda em background; a resposta volta na hora (o pg_net que
    // dispara nao segura a conexao pelo loop inteiro).
    const tarefa = rodarDescoberta(ctx, execId, override, max);
    if (typeof EdgeRuntime !== "undefined") {
      EdgeRuntime.waitUntil(tarefa);
    } else {
      // Fallback (dev local sem EdgeRuntime): aguarda o loop.
      await tarefa;
    }

    return jsonResponse({ ok: true, execucao_id: execId, gatilho }, 202);
  } catch (err) {
    return await errorResponse(err, { fn: "gmail-coletar" });
  }
}

getEnv();

Deno.serve(handler);
