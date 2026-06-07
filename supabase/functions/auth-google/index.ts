// =====================================================================
// Edge Function: auth-google  ->  POST /auth/google
// Fluxo Supabase Auth (OAuth Google) + validacao de allowlist (US-21).
//
// Dois modos no mesmo endpoint:
//   (A) Iniciacao (sem Bearer token): gera a URL de OAuth do Google via
//       Supabase Auth e a retorna { url } para o front redirecionar.
//   (B) Callback/validacao (com Bearer token da sessao recem-criada):
//       valida o e-mail contra contas_autorizadas; se autorizado retorna
//       { token, user: { email, perfil: 'interno' } }; senao signOut + 403.
//
// Causas separadas (SPEC 4.5.1):
//   - Falha tecnica do OAuth (rede/timeout/config) -> 502 oauth_error.
//   - Autenticado fora da allowlist / ativo=false   -> 403 acesso_negado.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { createAnonClient } from "../_shared/supabase.ts";
import { extractBearerToken, isEmailAllowed, revokeSession } from "../_shared/auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import type { AuthGoogleResponse, OAuthInitResponse } from "../_shared/types.ts";

interface AuthGoogleBody {
  provider?: string;
  redirectTo?: string;
}

async function parseBody(req: Request): Promise<AuthGoogleBody> {
  try {
    const raw = await req.text();
    if (!raw) return {};
    return JSON.parse(raw) as AuthGoogleBody;
  } catch {
    throw new HttpError(400, "invalid_body", "corpo da requisicao invalido (JSON esperado)");
  }
}

/** Modo (B): valida a sessao recem-criada contra a allowlist. */
async function handleCallback(req: Request, token: string): Promise<Response> {
  const db = createAnonClient(req);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) {
    // Sessao apresentada nao e valida: trata como falha tecnica do OAuth.
    throw new HttpError(401, "invalid_session", "sessao invalida apos o callback do OAuth");
  }

  const email = data.user.email?.trim().toLowerCase() ?? "";
  if (!email) {
    throw new HttpError(401, "invalid_session", "sessao sem e-mail associado");
  }

  const allowed = await isEmailAllowed(email);
  if (!allowed) {
    await revokeSession(token);
    await logSensitiveAction({
      tabela: "contas_autorizadas",
      acao: "access_denied",
      usuario: email,
      dadosNovos: { motivo: "fora_da_allowlist_ou_inativa", origem: "auth-google" },
    });
    throw new HttpError(403, "acesso_negado", "acesso negado: conta nao autorizada");
  }

  await logSensitiveAction({
    tabela: "contas_autorizadas",
    acao: "signin",
    usuario: email,
    dadosNovos: { origem: "auth-google" },
  });

  const body: AuthGoogleResponse = {
    token,
    user: { email, perfil: "interno" },
  };
  return jsonResponse(body, 200);
}

/** Modo (A): gera a URL de OAuth do Google. */
async function handleInitiation(req: Request, redirectTo?: string): Promise<Response> {
  const env = getEnv();
  const finalRedirect = redirectTo ?? env.authRedirectUrl;
  if (!finalRedirect) {
    throw new HttpError(
      400,
      "missing_redirect",
      "redirectTo ausente: informe a URL de callback do OAuth",
    );
  }

  const db = createAnonClient(req);
  const { data, error } = await db.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: finalRedirect, skipBrowserRedirect: true },
  });

  if (error || !data?.url) {
    // Falha tecnica do OAuth (config/rede) — distinta de "nao autorizado".
    throw new HttpError(
      502,
      "oauth_error",
      "nao foi possivel iniciar o login com o Google, tente novamente",
    );
  }

  const body: OAuthInitResponse = { url: data.url };
  return jsonResponse(body, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    const body = await parseBody(req);
    if (body.provider && body.provider !== "google") {
      throw new HttpError(400, "unsupported_provider", "provider nao suportado: use 'google'");
    }

    const token = extractBearerToken(req);
    if (token) {
      // Sessao presente -> validacao de allowlist (callback).
      return await handleCallback(req, token);
    }
    // Sem sessao -> inicia o fluxo OAuth.
    return await handleInitiation(req, body.redirectTo);
  } catch (err) {
    return await errorResponse(err, { fn: "auth-google" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
