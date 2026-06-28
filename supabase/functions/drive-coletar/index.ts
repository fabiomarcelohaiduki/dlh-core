// =====================================================================
// Edge Function: drive-coletar  ->  POST /drive-coletar
// DESCOBERTA da fonte 'drive' (camada 1) rodando DENTRO do Supabase (Edge
// Deno), no lugar do runner Node do GitHub Actions. Porta direta do
// .github/scripts/descobrir-drive.mjs: resolve as pastas ATIVAS (drive-pastas),
// lista cada pasta na API do Google (recursivo) e enfileira os arquivos na fila
// de documentos (via documentos-descobrir). NAO baixa bytes e NAO usa Tika ->
// leve. A extracao (Tika) segue separada.
//
// POR QUE SAIU DO GITHUB ACTIONS: o OAuth do Drive ja vive cifrado no Vault
// (a Edge drive-oauth troca o refresh por um access_token); a coleta so
// precisa do access_token + da API REST do Google, ambos alcancaveis daqui.
// Com o billing do Actions bloqueando os runs, a coleta migra para o mesmo
// modelo do Effecti: pg_cron -> Edge nativo.
//
// AUTH: apenas chamador SISTEMA (pg_cron / Edge drive-disparar) via
// X-Cron-Secret. Sem sessao humana. As Edges irmas (drive-oauth, drive-pastas,
// drive-execucao, documentos-descobrir) sao reusadas como estao: este Edge so
// orquestra o loop e fala com a API do Google (a unica parte que faltava em Deno).
//
// EXECUCAO EM BACKGROUND: o lock-por-fonte (abrirExecucao) e adquirido SINCRONO
// e o loop pesado (listar pastas + enfileirar) roda em EdgeRuntime.waitUntil,
// devolvendo 202 na hora. Assim o pg_net que dispara nao espera o loop inteiro
// (evita timeout) e o lock impede sobreposicao.
//
// Body (opcional, espelha os inputs do antigo workflow_dispatch):
//   gatilho    'manual' | 'agendada' (default 'agendada')
//   folder_id  override: descobre SO esta pasta (teste pontual de 1 pasta)
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { matchesCronSecret } from "../_shared/auth.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const DRIVE_API = "https://www.googleapis.com/drive/v3";

// MIME types nativos do Google (Docs/Sheets/Slides): sem md5Checksum nem
// download direto via alt=media. Adiados no piloto (files.export futuro).
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps";
const FOLDER_MIME = "application/vnd.google-apps.folder";

// Arquivos por POST ao documentos-descobrir (mesma fatia do runner). Uma pasta
// grande num unico POST estoura o timeout do gateway; o RPC e idempotente por
// file_id, entao fatiar e seguro e re-tentavel.
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
// Cliente Drive (porta do .github/scripts/drive.mjs para Deno). Sem
// diferenca de runtime relevante: so chamadas fetch + parsing de metadados.
// ---------------------------------------------------------------------

// Cache do access_token (vale ~1h; re-troca quando faltar < margem ou em 401).
let _tokenCache: { token: string | null; exp: number } = { token: null, exp: 0 };
const EXP_MARGIN_MS = 60_000;

/**
 * Obtem um access_token do Drive pedindo a Edge drive-oauth (action=
 * 'access-token'), que faz a troca com o refresh_token do Vault. Daqui so
 * passa o X-Cron-Secret + anon; o segredo do Google nunca trafega.
 */
async function getDriveAccessToken(ctx: ColetaCtx, force = false): Promise<string> {
  if (!force && _tokenCache.token && Date.now() < _tokenCache.exp - EXP_MARGIN_MS) {
    return _tokenCache.token;
  }
  const res = await fetch(`${ctx.baseUrl}/functions/v1/drive-oauth`, {
    method: "POST",
    headers: internalHeaders(ctx),
    body: JSON.stringify({ action: "access-token" }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`drive-oauth access-token falhou (${res.status}): ${text.slice(0, 300)}`);
  }
  let json: { accessToken?: string; expiresIn?: number };
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error("resposta nao-JSON da Edge drive-oauth");
  }
  const token = json.accessToken;
  const expiresIn = Number(json.expiresIn) || 3600;
  if (!token) throw new Error("drive-oauth nao devolveu accessToken");
  _tokenCache = { token, exp: Date.now() + expiresIn * 1000 };
  return token;
}

/** Extensao normalizada (sem ponto, minuscula) derivada do nome. */
function extensaoDoNome(nome: string | null): string | null {
  if (!nome) return null;
  const m = /\.([^.\\/]+)$/.exec(nome);
  return m ? m[1].toLowerCase() : null;
}

/** Assinatura de versao: md5Checksum (binarios) ou modifiedTime (resto). So
 *  re-extrai quando isto muda -> re-rodar a pasta nao re-baixa o inalterado. */
function assinaturaVersao(file: DriveFile): string | null {
  return file.md5Checksum || file.modifiedTime || null;
}

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
}

interface ArquivoDescoberta {
  file_id: string;
  nome: string | null;
  mimeType: string | null;
  extensao: string | null;
  tamanho: number | null;
  assinatura: string | null;
}

/**
 * Lista RECURSIVAMENTE os arquivos de uma pasta do Drive (entra em subpastas).
 * Pula os Google Docs nativos (sem md5/download direto; adiados no piloto) e
 * devolve metadados leves — NAO baixa bytes. Guarda contra atalhos ciclicos.
 */
async function listarArquivosPasta(
  ctx: ColetaCtx,
  folderId: string,
  token: string,
  vistos: Set<string> = new Set(),
): Promise<ArquivoDescoberta[]> {
  if (vistos.has(folderId)) return [];
  vistos.add(folderId);

  const arquivos: ArquivoDescoberta[] = [];
  const subpastas: string[] = [];
  let pageToken: string | null = null;

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
    const json = await res.json() as { files?: DriveFile[]; nextPageToken?: string };
    for (const f of json.files ?? []) {
      if (f.mimeType === FOLDER_MIME) {
        subpastas.push(f.id);
        continue;
      }
      if (typeof f.mimeType === "string" && f.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
        console.error(`[drive] pulando Google Doc nativo (sem download direto): ${f.name}`);
        continue;
      }
      arquivos.push({
        file_id: f.id,
        nome: f.name ?? null,
        mimeType: f.mimeType ?? null,
        extensao: extensaoDoNome(f.name ?? null),
        tamanho: f.size != null ? Number(f.size) : null,
        assinatura: assinaturaVersao(f),
      });
    }
    pageToken = json.nextPageToken ?? null;
  } while (pageToken);

  for (const sub of subpastas) {
    const filhos = await listarArquivosPasta(ctx, sub, token, vistos);
    arquivos.push(...filhos);
  }
  return arquivos;
}

// ---------------------------------------------------------------------
// Orquestracao (porta do descobrir-drive.mjs): execucao + pastas + enfileirar.
// ---------------------------------------------------------------------

interface PastaAtiva {
  folder_id?: string;
  nome?: string;
}

/** Pastas a descobrir: override (1 pasta) OU as ativas do cockpit. */
async function resolverPastas(ctx: ColetaCtx, override: string): Promise<PastaAtiva[]> {
  if (override) {
    console.log(`Override folder_id: descobrindo so a pasta ${override}.`);
    return [{ folder_id: override, nome: "(override)" }];
  }
  const res = await fetch(`${ctx.baseUrl}/functions/v1/drive-pastas`, {
    method: "POST",
    headers: internalHeaders(ctx),
    body: JSON.stringify({ action: "ativas" }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`drive-pastas (ativas) falhou (${res.status}): ${text.slice(0, 300)}`);
  }
  let json: { pastas?: unknown };
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error("resposta nao-JSON de drive-pastas.");
  }
  return Array.isArray(json.pastas) ? json.pastas as PastaAtiva[] : [];
}

/**
 * Abre a execucao da coleta (via drive-execucao). Devolve o execucao_id, ou
 * null se a fonte ja estiver coletando (lock-por-fonte) — caso em que aborta
 * sem rodar coleta duplicada.
 */
async function abrirExecucao(ctx: ColetaCtx, gatilho: string): Promise<string | null> {
  const res = await fetch(`${ctx.baseUrl}/functions/v1/drive-execucao`, {
    method: "POST",
    headers: internalHeaders(ctx),
    body: JSON.stringify({ action: "abrir", gatilho }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`drive-execucao (abrir) falhou (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as { execucao_id?: string; ja_em_andamento?: boolean };
  if (json.ja_em_andamento) {
    console.log(`Ja ha coleta do Drive em andamento (execucao ${json.execucao_id}). Abortando.`);
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
    const res = await fetch(`${ctx.baseUrl}/functions/v1/drive-execucao`, {
      method: "POST",
      headers: internalHeaders(ctx),
      body: JSON.stringify({ action: "fechar", execucao_id: execId, status, total, sucesso, erro, novos }),
    });
    if (!res.ok) {
      console.error(`AVISO: drive-execucao (fechar) falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`AVISO: falha ao fechar a execucao: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * Lista uma pasta e empurra os arquivos ao documentos-descobrir em lotes.
 * Devolve { total, inseridos }: total = arquivos baixaveis vistos (alimenta o
 * total_processar da execucao); inseridos = vinculos novos/reabertos.
 */
async function descobrirPasta(
  ctx: ColetaCtx,
  folderId: string,
  token: string,
): Promise<{ total: number; inseridos: number }> {
  const arquivos = await listarArquivosPasta(ctx, folderId, token);
  if (arquivos.length === 0) {
    console.log("  nenhum arquivo baixavel (pasta vazia ou so Google Docs nativos).");
    return { total: 0, inseridos: 0 };
  }
  let inseridos = 0;
  for (let i = 0; i < arquivos.length; i += LOTE) {
    const lote = arquivos.slice(i, i + LOTE);
    const res = await fetch(`${ctx.baseUrl}/functions/v1/documentos-descobrir`, {
      method: "POST",
      headers: internalHeaders(ctx),
      body: JSON.stringify({ fonte: "drive", arquivos: lote }),
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
    console.log(`  lote ${i / LOTE + 1}: ${lote.length} arquivo(s) -> novos/reabertos ${json.inseridos ?? "?"}`);
  }
  return { total: arquivos.length, inseridos };
}

/**
 * Loop completo da descoberta (roda em background apos o lock ser adquirido).
 * Espelha o main() do descobrir-drive.mjs: resolve as pastas ativas, obtem o
 * token, lista cada pasta (recursivo), enfileira e fecha a execucao.
 */
async function rodarDescoberta(ctx: ColetaCtx, execId: string, override: string): Promise<void> {
  try {
    const pastas = await resolverPastas(ctx, override);
    if (pastas.length === 0) {
      console.log("Nenhuma pasta do Drive ativa cadastrada. Nada a descobrir.");
      await fecharExecucao(ctx, execId, "concluida", 0, 0, 0);
      return;
    }

    console.log(`${pastas.length} pasta(s) do Drive a descobrir.`);
    const token = await getDriveAccessToken(ctx);
    let totalArquivos = 0;
    let totalInseridos = 0;
    for (const p of pastas) {
      const folderId = (p.folder_id ?? "").trim();
      if (!folderId) continue;
      console.log(`Pasta "${p.nome ?? folderId}" (${folderId})...`);
      const r = await descobrirPasta(ctx, folderId, token);
      totalArquivos += r.total;
      totalInseridos += r.inseridos;
    }
    console.log(
      `Descoberta Drive concluida. Arquivos=${totalArquivos}, vinculos novos/reabertos=${totalInseridos}.`,
    );
    // Todos os arquivos foram varridos/enfileirados -> processados = total (barra
    // 100% na conclusao). `novos` = vinculos ineditos apos dedup da fila.
    await fecharExecucao(ctx, execId, "concluida", totalArquivos, totalArquivos, 0, totalInseridos);
  } catch (err) {
    // Fecha a execucao como 'erro' antes de propagar (libera o lock-por-fonte).
    await fecharExecucao(ctx, execId, "erro", 0, 0, 0);
    console.error(`ERRO na descoberta Drive: ${(err as Error)?.message ?? err}`);
  }
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Apenas chamador SISTEMA (pg_cron / drive-disparar) via cron secret.
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
    const override = String(input.folder_id ?? "").trim();

    // Lock-por-fonte adquirido SINCRONO: se ja ha coleta, devolve sem agendar.
    const execId = await abrirExecucao(ctx, gatilho);
    if (execId === null) {
      return jsonResponse({ ok: true, ja_em_andamento: true }, 200);
    }

    // O loop pesado roda em background; a resposta volta na hora (o pg_net que
    // dispara nao segura a conexao pelo loop inteiro).
    const tarefa = rodarDescoberta(ctx, execId, override);
    if (typeof EdgeRuntime !== "undefined") {
      EdgeRuntime.waitUntil(tarefa);
    } else {
      // Fallback (dev local sem EdgeRuntime): aguarda o loop.
      await tarefa;
    }

    return jsonResponse({ ok: true, execucao_id: execId, gatilho }, 202);
  } catch (err) {
    return await errorResponse(err, { fn: "drive-coletar" });
  }
}

getEnv();

Deno.serve(handler);
