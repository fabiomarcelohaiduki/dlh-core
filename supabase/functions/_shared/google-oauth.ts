// =====================================================================
// _shared/google-oauth.ts
// Fluxo OAuth do Google (Web app) reutilizado por drive-oauth e gmail-oauth.
// Os dois eram ~95% identicos (decisao Fabio 2026-06-09: contas separadas,
// MESMO Client Web, refresh_token proprio por servico). Aqui fica o miolo;
// cada Edge so descreve suas diferencas via GoogleOAuthProvider e chama
// createGoogleOAuthHandler(provider).
//
//   MODOS (action no body, exceto o callback que e GET do Google):
//     'iniciar'       (sessao autorizada)  -> gera o state CSRF + URL de
//                     consentimento do Google e a devolve { url }.
//     GET /callback   (SEM sessao, vem do Google) -> valida o state, troca o
//                     code por refresh_token, le o e-mail da conta. Se a conta
//                     MUDOU, limpa a tabela de recursos do provider. Grava o
//                     refresh_token CIFRADO no Vault e registra a conta.
//                     Redireciona o navegador de volta ao cockpit.
//     'status'        (sessao autorizada)  -> { conectado, email, conectadoEm }.
//     'access-token'  (X-Cron-Secret, runner) -> troca o refresh_token do Vault
//                     por um access_token fresco { accessToken, expiresIn }.
//
//   Deploy com --no-verify-jwt (ver config.toml): o callback do Google chega
//   SEM Authorization e o gateway o barraria antes do codigo. Cada modo se
//   autentica sozinho (sessao / state / X-Cron-Secret).
// =====================================================================

import { handleCorsPreflight } from "./cors.ts";
import { errorResponse, HttpError, jsonResponse } from "./http.ts";
import { matchesCronSecret, requireAuthorizedUser } from "./auth.ts";
import { createServiceClient } from "./supabase.ts";
import { getServiceSecret, setServiceSecret } from "./vault.ts";
import { logSensitiveAction } from "./audit.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/** Idade maxima de um state CSRF antes de ser considerado expirado (15 min). */
const STATE_MAX_IDLE_MS = 15 * 60 * 1000;

/** Config do app OAuth Web resolvida do ambiente (clientId/secret compartilhados). */
export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;
  redirect: string;
  returnUrl: string;
}

/** Descreve as diferencas de um provider concreto (Drive ou Gmail). */
export interface GoogleOAuthProvider {
  /** Rotulo curto para logs e contexto de erro (ex.: "drive-oauth"). */
  fnLabel: string;
  /** Escopo OAuth especifico do servico (ex.: gmail.readonly). openid+email sao adicionados. */
  servicoScope: string;
  /** Nome deterministico do refresh_token no Vault (server-side only). */
  refreshSecretName: string;
  /** Chave do query param de retorno ao cockpit (?drive=... | ?gmail=...). */
  redirectParam: string;
  /** Tabela de states CSRF single-use. */
  stateTable: string;
  /** Tabela singleton (id=true) da conta conectada. */
  contaTable: string;
  /** Tabela de recursos zerada quando a conta muda (drive_pastas | gmail_labels). */
  recursosTable: string;
  /** Campo registrado na auditoria indicando que os recursos foram limpos. */
  recursosLimposField: string;
  /** Acao registrada na auditoria (conectar_drive | conectar_gmail). */
  auditAcao: string;
  /** Resolve a config do OAuth Web; 500 claro quando incompleta. */
  resolveConfig: () => OAuthAppConfig;
  /** Mensagens de erro especificas do provider. */
  msgs: {
    stateWriteFail: string;
    contaUpsertCode: string;
    contaUpsertFail: string;
    naoConectadoCode: string;
    naoConectadoFail: string;
    refreshFail: string;
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Gera um nonce aleatorio (state CSRF) com entropia suficiente. */
function gerarState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Redirect 302 do navegador de volta ao cockpit com o resultado da conexao. */
function redirectCockpit(
  provider: GoogleOAuthProvider,
  returnUrl: string,
  status: "conectado" | "erro",
): Response {
  const url = new URL(returnUrl);
  url.searchParams.set(provider.redirectParam, status);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

/** action='iniciar' — gera o state e a URL de consentimento do Google. */
async function handleIniciar(provider: GoogleOAuthProvider, req: Request): Promise<Response> {
  const { email } = await requireAuthorizedUser(req);
  const cfg = provider.resolveConfig();

  const service = createServiceClient();
  // Limpa states velhos antes de criar um novo (evita acumulo de nonces).
  await service
    .from(provider.stateTable)
    .delete()
    .lt("criado_em", new Date(Date.now() - STATE_MAX_IDLE_MS).toISOString());

  const state = gerarState();
  const { error } = await service
    .from(provider.stateTable)
    .insert({ state, email });
  if (error) {
    throw new HttpError(500, "state_write_failed", provider.msgs.stateWriteFail);
  }

  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", `openid email ${provider.servicoScope}`);
  url.searchParams.set("access_type", "offline");
  // prompt=consent forca o Google a devolver SEMPRE um refresh_token novo,
  // mesmo que a conta ja tenha concedido acesso antes (evita refresh ausente).
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);

  return jsonResponse({ url: url.toString() }, 200);
}

/** Consome o state (valida + apaga). Retorna o e-mail que iniciou ou null. */
async function consumirState(provider: GoogleOAuthProvider, state: string): Promise<string | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from(provider.stateTable)
    .select("email, criado_em")
    .eq("state", state)
    .maybeSingle();
  if (error || !data) return null;

  // Sempre apaga o nonce (single-use), valido ou expirado.
  await service.from(provider.stateTable).delete().eq("state", state);

  const idadeOk = Date.now() - new Date(data.criado_em as string).getTime() <= STATE_MAX_IDLE_MS;
  return idadeOk ? ((data.email as string) ?? null) : null;
}

/** Troca o authorization code por tokens (precisa do client_secret Web). */
async function trocarCodePorTokens(
  code: string,
  cfg: OAuthAppConfig,
): Promise<{ refreshToken: string | null; accessToken: string }> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirect,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(502, "oauth_token_failed", "falha ao concluir o consentimento do Google");
  }
  const json = JSON.parse(text) as { refresh_token?: string; access_token?: string };
  if (!json.access_token) {
    throw new HttpError(502, "oauth_token_failed", "Google nao devolveu access_token");
  }
  return { refreshToken: json.refresh_token ?? null, accessToken: json.access_token };
}

/** Le o e-mail da conta Google a partir de um access_token. */
async function lerEmailDaConta(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new HttpError(502, "userinfo_failed", "falha ao identificar a conta Google conectada");
  }
  const json = (await res.json()) as { email?: string };
  const email = json.email?.trim().toLowerCase() ?? "";
  if (!email) {
    throw new HttpError(502, "userinfo_failed", "conta Google sem e-mail associado");
  }
  return email;
}

/** GET /callback — Google redireciona aqui apos o consentimento. */
async function handleCallback(provider: GoogleOAuthProvider, req: Request): Promise<Response> {
  const cfg = provider.resolveConfig();
  const url = new URL(req.url);

  // Usuario negou o consentimento ou erro do Google.
  if (url.searchParams.get("error")) {
    return redirectCockpit(provider, cfg.returnUrl, "erro");
  }

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) {
    return redirectCockpit(provider, cfg.returnUrl, "erro");
  }

  const iniciadoPor = await consumirState(provider, state);
  if (!iniciadoPor) {
    // state invalido/expirado/reusado: nao prossegue (anti-CSRF).
    return redirectCockpit(provider, cfg.returnUrl, "erro");
  }

  // A partir daqui qualquer falha (token/userinfo/persistencia) deve devolver o
  // navegador ao cockpit com ?<param>=erro, nunca despejar JSON cru na tela. O
  // detalhe fica nos logs do Edge.
  try {
    const { refreshToken, accessToken } = await trocarCodePorTokens(code, cfg);
    if (!refreshToken) {
      // Sem refresh_token nao da pra renovar offline; trata como falha.
      return redirectCockpit(provider, cfg.returnUrl, "erro");
    }
    const email = await lerEmailDaConta(accessToken);

    const service = createServiceClient();

    // Conta anterior: se MUDOU, limpa os recursos cadastrados (decisao Fabio).
    const { data: contaAtual } = await service
      .from(provider.contaTable)
      .select("email")
      .eq("id", true)
      .maybeSingle();
    const emailAnterior = (contaAtual?.email as string | null) ?? null;
    const trocouConta = emailAnterior != null && emailAnterior !== email;
    if (trocouConta) {
      await service
        .from(provider.recursosTable)
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
    }

    // Grava o refresh_token CIFRADO no Vault (nunca persiste em coluna).
    await setServiceSecret(provider.refreshSecretName, refreshToken);

    // Registra a conta conectada (singleton id=true).
    const agora = new Date().toISOString();
    const { error: upErr } = await service
      .from(provider.contaTable)
      .upsert(
        { id: true, email, conectado_em: agora, atualizado_em: agora },
        { onConflict: "id" },
      );
    if (upErr) {
      throw new HttpError(500, provider.msgs.contaUpsertCode, provider.msgs.contaUpsertFail);
    }

    await logSensitiveAction({
      tabela: provider.contaTable,
      acao: provider.auditAcao,
      usuario: iniciadoPor,
      dadosNovos: {
        email,
        contaTrocada: trocouConta,
        [provider.recursosLimposField]: trocouConta,
      },
    });

    return redirectCockpit(provider, cfg.returnUrl, "conectado");
  } catch (err) {
    console.error(`[${provider.fnLabel}] callback falhou:`, err);
    return redirectCockpit(provider, cfg.returnUrl, "erro");
  }
}

/** action='status' — estado da conexao para o cockpit. */
async function handleStatus(provider: GoogleOAuthProvider, req: Request): Promise<Response> {
  await requireAuthorizedUser(req);
  const service = createServiceClient();
  const { data } = await service
    .from(provider.contaTable)
    .select("email, conectado_em")
    .eq("id", true)
    .maybeSingle();

  const email = (data?.email as string | null) ?? null;
  return jsonResponse(
    {
      conectado: Boolean(email),
      email,
      conectadoEm: (data?.conectado_em as string | null) ?? null,
    },
    200,
  );
}

/** action='access-token' — runner troca o refresh do Vault por um access_token. */
async function handleAccessToken(provider: GoogleOAuthProvider, req: Request): Promise<Response> {
  const ehSistema = await matchesCronSecret(req);
  if (!ehSistema) {
    throw new HttpError(401, "no_session", "X-Cron-Secret ausente ou invalido");
  }
  const cfg = provider.resolveConfig();

  const refreshToken = await getServiceSecret(provider.refreshSecretName);
  if (!refreshToken) {
    throw new HttpError(409, provider.msgs.naoConectadoCode, provider.msgs.naoConectadoFail);
  }

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(502, "oauth_refresh_failed", provider.msgs.refreshFail);
  }
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new HttpError(502, "oauth_refresh_failed", "Google nao devolveu access_token");
  }
  return jsonResponse(
    { accessToken: json.access_token, expiresIn: Number(json.expires_in) || 3600 },
    200,
  );
}

/** Constroi o handler Deno.serve completo para um provider OAuth do Google. */
export function createGoogleOAuthHandler(
  provider: GoogleOAuthProvider,
): (req: Request) => Promise<Response> {
  return async function handler(req: Request): Promise<Response> {
    const preflight = handleCorsPreflight(req);
    if (preflight) return preflight;

    try {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/callback")) {
        if (req.method !== "GET") {
          throw new HttpError(405, "method_not_allowed", "use GET no callback");
        }
        return await handleCallback(provider, req);
      }

      if (req.method !== "POST") {
        throw new HttpError(405, "method_not_allowed", "use POST");
      }
      const body = await readBody(req);
      const action = typeof body.action === "string" ? body.action : "";

      switch (action) {
        case "iniciar":
          return await handleIniciar(provider, req);
        case "status":
          return await handleStatus(provider, req);
        case "access-token":
          return await handleAccessToken(provider, req);
        default:
          throw new HttpError(
            422,
            "acao_invalida",
            "action deve ser 'iniciar', 'status' ou 'access-token'",
          );
      }
    } catch (err) {
      return await errorResponse(err, { fn: provider.fnLabel });
    }
  };
}
