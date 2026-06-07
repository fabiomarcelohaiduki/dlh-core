// =====================================================================
// _shared/supabase.ts
// Fabricas de clientes Supabase para Edge Functions.
//
//  - createAnonClient(req): cliente com a chave anonima encaminhando o
//    Authorization do usuario. Toda query respeita a RLS no contexto do
//    usuario autenticado (defense in depth junto ao _shared/auth.ts).
//
//  - createServiceClient(): cliente service_role que BYPASSA a RLS. Uso
//    estritamente server-side e restrito (checagem de allowlist, escrita
//    no audit_log). Nunca exposto ao cliente.
// =====================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "./env.ts";

const NO_PERSIST = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

/**
 * Cliente com escopo do usuario: encaminha o header Authorization para que a
 * RLS do Postgres avalie `is_conta_autorizada()` com o JWT real.
 */
export function createAnonClient(req: Request): SupabaseClient {
  const env = getEnv();
  const authHeader = req.headers.get("Authorization") ?? "";
  return createClient(env.supabaseUrl, env.anonKey, {
    ...NO_PERSIST,
    global: { headers: { Authorization: authHeader } },
  });
}

/**
 * Cliente service_role (bypassa RLS). Restrito a operacoes de plataforma:
 * validar allowlist, registrar auditoria, revogar sessao. NUNCA retornar
 * dados deste cliente sem autorizacao previa.
 */
export function createServiceClient(): SupabaseClient {
  const env = getEnv();
  return createClient(env.supabaseUrl, env.serviceRoleKey, NO_PERSIST);
}
