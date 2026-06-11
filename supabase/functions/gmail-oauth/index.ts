// =====================================================================
// Edge Function: gmail-oauth
// Conexao OAuth do Gmail pelo cockpit, INDEPENDENTE do Drive (decisao Fabio
// 2026-06-09: conta separada). Reusa o MESMO Client Web do login/Drive (mesmo
// app OAuth) — a "conta separada" vem do refresh_token distinto no Vault
// (GMAIL_REFRESH_TOKEN) e das tabelas proprias, nao de um app novo.
// Escopo: gmail.readonly (so leitura).
//
// O fluxo (iniciar / callback / status / access-token) vive em
// _shared/google-oauth.ts; aqui so descrevemos as diferencas do Gmail.
// =====================================================================

import { getEnv } from "../_shared/env.ts";
import { HttpError } from "../_shared/http.ts";
import {
  createGoogleOAuthHandler,
  type GoogleOAuthProvider,
  type OAuthAppConfig,
} from "../_shared/google-oauth.ts";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Nome deterministico do refresh_token do Gmail no Vault (server-side only). */
const GMAIL_REFRESH_NAME = "GMAIL_REFRESH_TOKEN" as const;

/** Le e valida a config do OAuth Web; 500 claro quando incompleta (deploy/secret faltando). */
function requireOauthConfig(): OAuthAppConfig {
  const env = getEnv();
  // Reusa o Client Web do Drive/login; so o redirect e proprio do Gmail.
  if (
    !env.driveOauthClientId ||
    !env.driveOauthClientSecret ||
    !env.gmailOauthRedirect ||
    !env.gmailOauthReturnUrl
  ) {
    throw new HttpError(
      500,
      "gmail_oauth_nao_configurado",
      "conexao do Gmail indisponivel: secrets do OAuth Web (GMAIL_OAUTH_REDIRECT) ausentes no Edge",
    );
  }
  return {
    clientId: env.driveOauthClientId,
    clientSecret: env.driveOauthClientSecret,
    redirect: env.gmailOauthRedirect,
    returnUrl: env.gmailOauthReturnUrl,
  };
}

const PROVIDER: GoogleOAuthProvider = {
  fnLabel: "gmail-oauth",
  servicoScope: GMAIL_SCOPE,
  refreshSecretName: GMAIL_REFRESH_NAME,
  redirectParam: "gmail",
  stateTable: "gmail_oauth_state",
  contaTable: "gmail_conta",
  recursosTable: "gmail_labels",
  recursosLimposField: "labelsLimpas",
  auditAcao: "conectar_gmail",
  resolveConfig: requireOauthConfig,
  msgs: {
    stateWriteFail: "falha ao iniciar a conexao com o Gmail",
    contaUpsertCode: "gmail_conta_upsert_failed",
    contaUpsertFail: "falha ao registrar a conta do Gmail",
    naoConectadoCode: "gmail_nao_conectado",
    naoConectadoFail: "Gmail nao conectado: conecte a conta no cockpit",
    refreshFail: "falha ao renovar o access_token do Gmail",
  },
};

getEnv();

Deno.serve(createGoogleOAuthHandler(PROVIDER));
