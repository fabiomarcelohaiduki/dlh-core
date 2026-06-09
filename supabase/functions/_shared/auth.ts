// =====================================================================
// _shared/auth.ts
// Autenticacao + autorizacao na borda (defense in depth junto a RLS).
//
// Fluxo de enforcement (US-21, RF-38):
//   1. Extrai o Bearer token do header Authorization (senao 401).
//   2. Valida a sessao Supabase via getUser(token) (senao 401).
//   3. Compara o e-mail autenticado com contas_autorizadas (e-mail OU
//      dominio, ativo = true) usando service_role (server-side).
//   4. Conta nao autorizada / ativo=false -> signOut imediato + 403.
//
// Reutilizado por TODOS os endpoints protegidos.
// =====================================================================

import { type SupabaseClient, type User } from "@supabase/supabase-js";
import { createAnonClient, createServiceClient } from "./supabase.ts";
import { HttpError } from "./http.ts";
import { logSensitiveAction } from "./audit.ts";
import { getServiceSecret } from "./vault.ts";

const CRON_SECRET_NAME = "CRON_DISPATCH_SECRET" as const;

/** Comparacao de strings em tempo constante (anti timing-attack). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifica se a requisicao carrega o cron secret interno (header X-Cron-Secret
 * == segredo no Vault). Usado por endpoints internos (runner do Actions, que
 * NAO tem service_role, so o cron secret). Curto-circuita sem header presente
 * para nao consultar o Vault em chamadas de cockpit/usuario.
 */
export async function matchesCronSecret(req: Request): Promise<boolean> {
  const provided = req.headers.get("X-Cron-Secret")?.trim() ?? "";
  if (!provided) return false;
  const expected = (await getServiceSecret(CRON_SECRET_NAME))?.trim() ?? "";
  return expected.length > 0 && timingSafeEqual(provided, expected);
}

export interface AuthorizedContext {
  /** Usuario autenticado (Supabase Auth). */
  user: User;
  /** E-mail normalizado (lowercase) do usuario. */
  email: string;
  /** Perfil unico do MVP. */
  perfil: "interno";
  /** Cliente com escopo do usuario (RLS aplicada). */
  db: SupabaseClient;
}

/** Extrai o token do header `Authorization: Bearer <token>`. */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!token || scheme?.toLowerCase() !== "bearer") return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Verifica se o e-mail consta na allowlist (contas_autorizadas) por e-mail
 * completo OU dominio, com ativo = true. Usa service_role (server-side) para
 * nao depender da RLS na propria checagem de autorizacao.
 */
export async function isEmailAllowed(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.includes("@") ? normalized.split("@")[1] ?? "" : "";
  if (!normalized) return false;

  const service = createServiceClient();
  const candidates = domain ? [normalized, domain] : [normalized];
  const { data, error } = await service
    .from("contas_autorizadas")
    .select("tipo, valor, ativo")
    .eq("ativo", true)
    .in("valor", candidates);

  if (error) {
    throw new HttpError(500, "allowlist_check_failed", "falha ao validar autorizacao");
  }

  return (data ?? []).some((row) => {
    const valor = String(row.valor ?? "").toLowerCase();
    if (row.tipo === "email") return valor === normalized;
    if (row.tipo === "dominio") return valor === domain;
    return false;
  });
}

/**
 * Revoga a sessao do usuario (signOut server-side) via admin API.
 * Best-effort: nunca propaga erro de revogacao.
 */
export async function revokeSession(token: string): Promise<void> {
  try {
    const service = createServiceClient();
    await service.auth.admin.signOut(token);
  } catch (err) {
    console.error("[auth] falha ao revogar sessao", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Valida a sessao e a autorizacao. Lanca HttpError com o status correto:
 *   401 -> sem sessao / sessao invalida
 *   403 -> autenticado porem fora da allowlist (com signOut)
 * Retorna o contexto autorizado para uso pelo endpoint.
 */
export async function requireAuthorizedUser(req: Request): Promise<AuthorizedContext> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new HttpError(401, "no_session", "autenticacao requerida: sessao ausente");
  }

  const db = createAnonClient(req);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) {
    throw new HttpError(401, "invalid_session", "sessao invalida ou expirada");
  }

  const email = data.user.email?.trim().toLowerCase() ?? "";
  if (!email) {
    throw new HttpError(401, "invalid_session", "sessao sem e-mail associado");
  }

  const allowed = await isEmailAllowed(email);
  if (!allowed) {
    // Conta autenticada porem nao autorizada (ou ativo=false): revoga e nega.
    await revokeSession(token);
    await logSensitiveAction({
      tabela: "contas_autorizadas",
      acao: "access_denied",
      usuario: email,
      dadosNovos: { motivo: "fora_da_allowlist_ou_inativa" },
    });
    throw new HttpError(403, "acesso_negado", "acesso negado: conta nao autorizada");
  }

  return { user: data.user, email, perfil: "interno", db };
}
