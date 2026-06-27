// =====================================================================
// Helper de sessao para a camada de API da Fase 0 (Cockpit LionClaw).
//
// `configuracao` e `bloco_config` sao isoladas por (user_id, org_id). A RLS
// (SPEC 2.2.2) ja restringe a leitura/escrita a `user_id = auth.uid()`, mas
// as escritas (insert/upsert) precisam carimbar `user_id` e `org_id`
// explicitamente. Este modulo centraliza a resolucao do par autenticado.
//
// O `org_id` e resolvido via RPC SECURITY DEFINER `current_user_orgs()`
// (migration 1/4), evitando dependencia da RLS de `org_membership` no client.
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

/** Cliente Supabase tipado com o schema da Fase 0. */
export type TypedClient = SupabaseClient<Database>;

/**
 * Cliente Supabase do browser tipado com o `Database` da Fase 0.
 *
 * O `createClient()` compartilhado e intencionalmente nao-generico (o app
 * acessa muitas tabelas fora deste schema). Aqui aplicamos o tipo `Database`
 * localmente para ganhar type-safety nas tabelas tema/configuracao/bloco_config
 * sem acoplar o client global.
 */
export function db(): TypedClient {
  return createClient() as unknown as TypedClient;
}

/** Par autenticado (usuario + organizacao ativa). */
export interface UserOrg {
  userId: string;
  orgId: string;
}

/**
 * Resolve o usuario autenticado e sua organizacao ativa.
 *
 * @throws Error quando nao ha sessao ou o usuario nao possui vinculo de
 *   organizacao (`org_membership`). As escritas dependem de ambos.
 */
export async function resolveUserOrg(client: TypedClient): Promise<UserOrg> {
  const { data: auth, error: authErr } = await client.auth.getUser();
  if (authErr || !auth?.user) {
    throw new Error("Sessao ausente: usuario nao autenticado.");
  }

  const { data: orgs, error: orgErr } = await client.rpc("current_user_orgs");
  if (orgErr) {
    throw new Error(`Falha ao resolver organizacao: ${orgErr.message}`);
  }

  const orgId = Array.isArray(orgs) ? orgs[0] : undefined;
  if (!orgId) {
    throw new Error("Usuario sem organizacao vinculada (org_membership).");
  }

  return { userId: auth.user.id, orgId };
}
