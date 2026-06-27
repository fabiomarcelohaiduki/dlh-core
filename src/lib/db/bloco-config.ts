// =====================================================================
// Camada de dados (db/) — config por escopo (tabela `bloco_config`, SPEC 2.1.9).
//
// Persistencia canonica via Supabase client direto com RLS (D-BE-01). Um
// registro por (user_id, org_id, escopo, tipo). Isolamento via RLS
// (`user_id = auth.uid()` + org da membership); as escritas carimbam
// user_id/org_id explicitamente (exigido no INSERT/UPSERT).
//
// Expoe:
//   - getBlocoConfig(userId, orgId, escopo?, tipo?)        leitura por escopo
//   - upsertBlocoConfig(userId, orgId, escopo, tipo, valor) UPSERT (jsonb)
//   - upsertBlocoConfigRows(client, rows)                  escrita em lote (migrador)
// =====================================================================

import { db, type TypedClient } from "@/lib/api/session";
import type {
  BlocoConfigInsert,
  BlocoConfigRow,
  BlocoTipo,
} from "@/types/database";
import type { BlocoConfig } from "@/types/domain";

const ON_CONFLICT = "user_id,org_id,escopo,tipo";

function rowToBlocoConfig(r: BlocoConfigRow): BlocoConfig {
  return {
    id: r.id,
    userId: r.user_id,
    orgId: r.org_id,
    escopo: r.escopo,
    tipo: r.tipo,
    visivel: r.visivel,
    ordem: r.ordem,
    banda: r.banda,
    valor: r.valor,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Leitura por escopo. Quando `escopo` e informado, retorna a entrada exata E
 * suas descendentes hierarquicas (`escopo.*`). Filtro opcional por `tipo`. Sem
 * `escopo`, retorna todas as entradas do usuario/org (usado no bootstrap). A
 * RLS ja restringe ao usuario autenticado; o par (userId, orgId) e mantido na
 * assinatura para tornar o escopo do dado explicito ao chamador.
 */
export async function getBlocoConfig(
  userId: string,
  orgId: string,
  escopo?: string,
  tipo?: BlocoTipo,
  client: TypedClient = db(),
): Promise<BlocoConfig[]> {
  let q = client
    .from("bloco_config")
    .select("*")
    .eq("user_id", userId)
    .eq("org_id", orgId);
  if (escopo) q = q.or(`escopo.eq.${escopo},escopo.like.${escopo}.%`);
  if (tipo) q = q.eq("tipo", tipo);
  const { data, error } = await q.order("ordem", { ascending: true });
  if (error) throw new Error(`Falha ao ler bloco_config: ${error.message}`);
  return (data ?? []).map(rowToBlocoConfig);
}

/**
 * UPSERT de um bloco por (user_id, org_id, escopo, tipo). `valor` e o payload
 * jsonb da entrada (visibilidade/ordem/banda usam os defaults do banco no
 * insert e permanecem inalterados no update). Idempotente por restricao UNIQUE.
 */
export async function upsertBlocoConfig(
  userId: string,
  orgId: string,
  escopo: string,
  tipo: BlocoTipo,
  valor: Record<string, unknown> | null,
  client: TypedClient = db(),
): Promise<BlocoConfig> {
  const insert: BlocoConfigInsert = {
    user_id: userId,
    org_id: orgId,
    escopo,
    tipo,
    valor,
  };
  const { data, error } = await client
    .from("bloco_config")
    .upsert(insert, { onConflict: ON_CONFLICT })
    .select("*")
    .single();
  if (error) throw new Error(`Falha ao gravar bloco_config: ${error.message}`);
  return rowToBlocoConfig(data);
}

/**
 * Escrita low-level: UPSERT de linhas ja carimbadas (user_id/org_id/escopo/tipo).
 * Usada pelo migrador (cfg.ts) para importar cards/widgets/blocos legados com
 * visibilidade/ordem/banda. No-op para lista vazia.
 */
export async function upsertBlocoConfigRows(
  client: TypedClient,
  rows: BlocoConfigInsert[],
): Promise<BlocoConfig[]> {
  if (rows.length === 0) return [];
  const { data, error } = await client
    .from("bloco_config")
    .upsert(rows, { onConflict: ON_CONFLICT })
    .select("*");
  if (error) throw new Error(`Falha ao gravar bloco_config: ${error.message}`);
  return (data ?? []).map(rowToBlocoConfig);
}
