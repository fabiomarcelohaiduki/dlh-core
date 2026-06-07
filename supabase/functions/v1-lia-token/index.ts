// =====================================================================
// Edge Function: v1-lia-token  ->  POST /v1/lia/token
// Gestao da API key de servico read-only da Lia (RNF-01).
//
//   - action 'rotate': emite uma nova API key aleatoria, grava no Vault
//     (substituindo a anterior) e a devolve UMA unica vez para configurar a
//     Lia. A chave nunca mais e recuperavel apos esta resposta.
//   - action 'revoke': remove a chave do Vault; chamadas com a chave antiga
//     deixam de autenticar imediatamente.
//
// Protegido pela SESSAO DO COCKPIT (sessao humana autorizada), nunca pela
// service_role nem pela propria API key da Lia: a emissao/revogacao e ato
// administrativo humano. A 'tela api' usa a sessao do cockpit, jamais expoe
// a service key no front.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { liaTokenActionSchema, parseJsonBody } from "../_shared/validation.ts";
import { LIA_SERVICE_KEY_NAME, revokeServiceSecret, setServiceSecret } from "../_shared/vault.ts";
import type { LiaTokenResponse } from "../_shared/types.ts";

/** Prefixo legivel da API key de servico (facilita identificacao em logs externos da Lia). */
const KEY_PREFIX = "lia_sk_";
/** Entropia da chave: 32 bytes (256 bits) — folgado para uso programatico. */
const KEY_BYTES = 32;

/** Codifica bytes em base64url (sem padding) para uma API key URL-safe. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Gera uma API key de servico aleatoria e imprevisivel. */
function generateApiKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return `${KEY_PREFIX}${toBase64Url(bytes)}`;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Ato administrativo: exige sessao humana autorizada (defense in depth).
    const { email } = await requireAuthorizedUser(req);

    const { action } = await parseJsonBody(req, liaTokenActionSchema);

    if (action === "rotate") {
      const apiKey = generateApiKey();
      const ok = await setServiceSecret(LIA_SERVICE_KEY_NAME, apiKey);

      // Auditoria SEM o segredo: registra apenas a acao (RNF-08).
      await logSensitiveAction({
        tabela: "fontes",
        acao: "rotacionar_lia_token",
        usuario: email,
        dadosNovos: { segredo: LIA_SERVICE_KEY_NAME, rotacionado: ok },
      });

      // Chave devolvida UMA unica vez para configurar a Lia.
      const body: LiaTokenResponse = { action, ok, apiKey: ok ? apiKey : null };
      return jsonResponse(body, ok ? 201 : 500);
    }

    // action === "revoke"
    const ok = await revokeServiceSecret(LIA_SERVICE_KEY_NAME);
    await logSensitiveAction({
      tabela: "fontes",
      acao: "revogar_lia_token",
      usuario: email,
      dadosNovos: { segredo: LIA_SERVICE_KEY_NAME, revogado: ok },
    });

    const body: LiaTokenResponse = { action, ok, apiKey: null };
    return jsonResponse(body, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "v1-lia-token" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
