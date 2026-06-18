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
import { getServiceSecret, LIA_SERVICE_KEY_NAME, TRIAGEM_WRITE_KEY_NAME } from "./vault.ts";
import { timingSafeEqual } from "./crypto.ts";

/** Escopo concedido a API key de servico da Lia (read-only + busca semantica). */
export const LIA_SERVICE_SCOPE = "read-only:busca-semantica" as const;

/**
 * Escopo de ESCRITA da triagem (POST veredito). Credencial de servico distinta
 * da read-only da Lia, guardada no Vault sob outro nome. A FILA (read-only) e o
 * VEREDITO (write) usam credenciais com escopos diferentes (RNF-01, SEC-1).
 */
export const TRIAGEM_WRITE_SCOPE = "write:triagem" as const;

/** Escopos reconhecidos no contrato /v1 para credenciais de servico. */
export type V1Scope = typeof LIA_SERVICE_SCOPE | typeof TRIAGEM_WRITE_SCOPE;

/** Principal autenticado no contrato /v1: servico (Lia/triagem) ou humano (cockpit). */
export type V1Principal =
  | {
    readonly kind: "service";
    readonly scope: V1Scope;
    /** Identificador estavel para auditoria (sem expor o segredo). */
    readonly principal: "lia-service" | "triagem-service";
  }
  | {
    readonly kind: "human";
    /** E-mail normalizado do usuario autorizado do cockpit. */
    readonly email: string;
  };

/** Opcoes de autorizacao na borda do contrato /v1. */
export interface AuthenticateV1Options {
  /**
   * Quando informado, o recurso e EXCLUSIVO de servico e exige uma credencial
   * com EXATAMENTE este escopo. Credencial de servico com escopo diferente OU
   * sessao humana resultam em 403 (autorizacao na borda, antes do corpo).
   * Ausente => comportamento legado (servico de qualquer escopo OU humano).
   */
  readonly requiredScope?: V1Scope;
}

/**
 * Autentica uma requisicao ao contrato /v1 e retorna o principal com o escopo
 * associado. A comparacao das credenciais de servico (Vault) e feita em tempo
 * constante (timingSafeEqual), anti timing-attack.
 *
 * Codigos de erro (autorizacao na borda, ANTES de processar o corpo/insumos):
 *   - 401 no_credential   -> nenhuma credencial apresentada.
 *   - 403 escopo_invalido -> credencial valida porem sem o escopo requerido
 *                            (ou sessao humana em recurso exclusivo de servico).
 *   - 403 acesso_negado   -> sessao humana fora da allowlist (recurso aberto a humano).
 */
export async function authenticateV1(
  req: Request,
  options: AuthenticateV1Options = {},
): Promise<V1Principal> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new HttpError(401, "no_credential", "autenticacao requerida: credencial ausente");
  }

  // 1) API key de servico read-only da Lia (FILA / busca semantica).
  const liaKey = await getServiceSecret(LIA_SERVICE_KEY_NAME);
  if (liaKey && timingSafeEqual(token, liaKey)) {
    return assertScope(
      { kind: "service", scope: LIA_SERVICE_SCOPE, principal: "lia-service" },
      options,
    );
  }

  // 2) API key de servico de ESCRITA da triagem (VEREDITO).
  const triagemKey = await getServiceSecret(TRIAGEM_WRITE_KEY_NAME);
  if (triagemKey && timingSafeEqual(token, triagemKey)) {
    return assertScope(
      { kind: "service", scope: TRIAGEM_WRITE_SCOPE, principal: "triagem-service" },
      options,
    );
  }

  // 3) Recurso exclusivo de servico: NAO recai para sessao humana. Token nao
  //    reconhecido como credencial de servico => 403 na borda (sem getUser).
  if (options.requiredScope) {
    throw new HttpError(
      403,
      "escopo_invalido",
      "credencial sem o escopo requerido para este recurso",
    );
  }

  // 4) Recurso aberto a humano (playground): recai para a sessao do cockpit
  //    (Supabase Auth + allowlist). Propaga 401 (sessao invalida) ou 403
  //    (fora da allowlist) de requireAuthorizedUser.
  const { email } = await requireAuthorizedUser(req);
  return { kind: "human", email };
}

/** Aplica a checagem de escopo na borda para principais de servico. */
function assertScope(principal: V1Principal, options: AuthenticateV1Options): V1Principal {
  if (
    options.requiredScope &&
    (principal.kind !== "service" || principal.scope !== options.requiredScope)
  ) {
    throw new HttpError(
      403,
      "escopo_invalido",
      "credencial sem o escopo requerido para este recurso",
    );
  }
  return principal;
}

/** Rotulo do principal para auditoria (nunca expoe a API key). */
export function principalLabel(principal: V1Principal): string {
  return principal.kind === "service" ? principal.principal : principal.email;
}
