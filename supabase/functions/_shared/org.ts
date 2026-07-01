import { HttpError } from "./http.ts";
import { createServiceClient } from "./supabase.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

async function orgPorMembership(
  db: ServiceClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("org_membership")
    .select("org_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "org_resolve_failed", "falha ao resolver organizacao do operador");
  }
  return (data as { org_id: string } | null)?.org_id ?? null;
}

async function orgAtivaFallback(db: ServiceClient): Promise<string> {
  const fromEnv = Deno.env.get("RELACIONAMENTOS_ACTIVE_ORG_ID")?.trim();
  if (fromEnv) return fromEnv;

  const { data: cfg, error: cfgError } = await db
    .from("config_relacionamentos")
    .select("org_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (cfgError) {
    throw new HttpError(500, "org_resolve_failed", "falha ao consultar config_relacionamentos");
  }
  const orgConfig = (cfg as { org_id: string } | null)?.org_id;
  if (orgConfig) return orgConfig;

  const { data: org, error: orgError } = await db
    .from("org")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (orgError) {
    throw new HttpError(500, "org_resolve_failed", "falha ao consultar organizacao ativa");
  }
  const orgId = (org as { id: string } | null)?.id;
  if (!orgId) {
    throw new HttpError(
      403,
      "sem_org_vinculada",
      "nenhuma organizacao ativa encontrada para relacionamentos",
    );
  }
  return orgId;
}

export async function resolverOrgIdUsuario(
  db: ServiceClient,
  userId: string,
): Promise<string> {
  return (await orgPorMembership(db, userId)) ?? await orgAtivaFallback(db);
}

export async function resolverOrgAtivaBackfill(
  db: ServiceClient,
  userId: string | null,
): Promise<string> {
  if (userId) {
    const membership = await orgPorMembership(db, userId);
    if (membership) return membership;
  }
  return await orgAtivaFallback(db);
}
