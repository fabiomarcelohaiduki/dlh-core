// =====================================================================
// Edge Function: drive-oauth
// Conexao OAuth do Google Drive pelo cockpit (substitui a colagem manual do
// refresh_token nos Secrets do Actions). Consolida os segredos do Google no
// Vault/Edge: o runner deixa de guardar CLIENT_ID/SECRET/REFRESH_TOKEN.
//
// O fluxo (iniciar / callback / status / access-token) vive em
// _shared/google-oauth.ts; aqui so descrevemos as diferencas do Drive.
// =====================================================================

import { getEnv } from "../_shared/env.ts";
import { HttpError } from "../_shared/http.ts";
import {
  createGoogleOAuthHandler,
  type GoogleOAuthProvider,
  type OAuthAppConfig,
} from "../_shared/google-oauth.ts";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Nome deterministico do refresh_token do Drive no Vault (server-side only). */
const DRIVE_REFRESH_NAME = "GOOGLE_DRIVE_REFRESH_TOKEN" as const;

/** Le e valida a config do OAuth Web; 500 claro quando incompleta (deploy/secret faltando). */
function requireOauthConfig(): OAuthAppConfig {
  const env = getEnv();
  if (
    !env.driveOauthClientId ||
    !env.driveOauthClientSecret ||
    !env.driveOauthRedirect ||
    !env.driveOauthReturnUrl
  ) {
    throw new HttpError(
      500,
      "drive_oauth_nao_configurado",
      "conexao do Drive indisponivel: secrets do OAuth Web ausentes no Edge",
    );
  }
  return {
    clientId: env.driveOauthClientId,
    clientSecret: env.driveOauthClientSecret,
    redirect: env.driveOauthRedirect,
    returnUrl: env.driveOauthReturnUrl,
  };
}

const PROVIDER: GoogleOAuthProvider = {
  fnLabel: "drive-oauth",
  servicoScope: DRIVE_SCOPE,
  refreshSecretName: DRIVE_REFRESH_NAME,
  redirectParam: "drive",
  stateTable: "drive_oauth_state",
  contaTable: "drive_conta",
  recursosTable: "drive_pastas",
  recursosLimposField: "pastasLimpas",
  auditAcao: "conectar_drive",
  resolveConfig: requireOauthConfig,
  msgs: {
    stateWriteFail: "falha ao iniciar a conexao com o Drive",
    contaUpsertCode: "drive_conta_upsert_failed",
    contaUpsertFail: "falha ao registrar a conta do Drive",
    naoConectadoCode: "drive_nao_conectado",
    naoConectadoFail: "Drive nao conectado: conecte a conta no cockpit",
    refreshFail: "falha ao renovar o access_token do Drive",
  },
};

getEnv();

Deno.serve(createGoogleOAuthHandler(PROVIDER));
