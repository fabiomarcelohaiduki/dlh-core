// =====================================================================
// _shared/service-auth.ts
// Autenticacao da API versionada /v1 (RNF-01/RNF-17). O contrato /v1 aceita
// DUAS credenciais distintas, ambas no header Authorization: Bearer:
//
//   1. API key de servico read-only da Lia (LIA_SERVICE_API_KEY), guardada
//      no Vault, rotacionavel/revogavel. Escopo: read-only + busca semantica.
//      Distinta da service_role e da sessao humana (RNF-01).
//   2. Sessao do cockpit (playground/validacao humana) — o mesmo fluxo de
//      _shared/auth.ts (sessao Supabase + allowlist), sem expor a API key no
//      front.
//
// Chamadas sem nenhuma credencial valida retornam 401. A ordem testa primeiro
// a API key de servico (comparacao em tempo constante) e, se nao casar, recai
// para a sessao humana.
// =====================================================================

import { extractBearerToken, requireAuthorizedUser } from "./auth.ts";
import { HttpError } from "./http.ts";
import { getServiceSecret, LIA_SERVICE_KEY_NAME } from "./vault.ts";
import { timingSafeEqual } from "./crypto.ts";

/** Escopo concedido a API key de servico da Lia (read-only + busca semantica). */
export const LIA_SERVICE_SCOPE = "read-only:busca-semantica" as const;

/** Principal autenticado no contrato /v1: servico (Lia) ou humano (cockpit). */
export type V1Principal =
  | {
    readonly kind: "service";
    readonly scope: typeof LIA_SERVICE_SCOPE;
    /** Identificador estavel para auditoria (sem expor o segredo). */
    readonly principal: "lia-service";
  }
  | {
    readonly kind: "human";
    /** E-mail normalizado do usuario autorizado do cockpit. */
    readonly email: string;
  };

/**
 * Autentica uma requisicao ao contrato /v1. Retorna o principal (servico ou
 * humano). Lanca HttpError 401 quando nenhuma credencial valida e apresentada
 * e 403 quando a sessao humana e valida porem nao autorizada (allowlist).
 */
export async function authenticateV1(req: Request): Promise<V1Principal> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new HttpError(401, "no_credential", "autenticacao requerida: credencial ausente");
  }

  // 1) Tenta casar com a API key de servico da Lia (Vault). Quando a chave
  //    ainda nao foi emitida/foi revogada, segue para a sessao humana.
  const serviceKey = await getServiceSecret(LIA_SERVICE_KEY_NAME);
  if (serviceKey && timingSafeEqual(token, serviceKey)) {
    return { kind: "service", scope: LIA_SERVICE_SCOPE, principal: "lia-service" };
  }

  // 2) Recai para a sessao do cockpit (Supabase Auth + allowlist). Propaga
  //    401 (sessao invalida) ou 403 (fora da allowlist) de requireAuthorizedUser.
  const { email } = await requireAuthorizedUser(req);
  return { kind: "human", email };
}

/** Rotulo do principal para auditoria (nunca expoe a API key). */
export function principalLabel(principal: V1Principal): string {
  return principal.kind === "service" ? principal.principal : principal.email;
}
