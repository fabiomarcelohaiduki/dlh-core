// =====================================================================
// API layer — config reutilizavel por escopo (tabela `bloco_config`, SPEC 2.1.9).
//
// Um registro por (user_id, org_id, escopo, tipo). Substitui as chaves legadas
// dlh.blockvis/blockorder/bandorder/cfg.cards/cfg.widgets. Isolamento por
// user_id+org_id (RLS); as escritas carimbam o par via `resolveUserOrg`.
//
// Expoe:
//   - getBlocoConfig(escopo?, tipo?)      leitura por escopo hierarquico
//   - upsertBlocoConfigLote(items)        upsert em lote (visibilidade/ordem/banda)
//   - pruneBlocoConfig(ids)               remocao de orfaos (SPEC 2.3.2, app code)
//   - upsertBlocoConfigRows(client, rows) escrita low-level (usada pelo migrador)
// =====================================================================

import { db, resolveUserOrg, type TypedClient } from "@/lib/api/session";
import type {
  BlocoBanda,
  BlocoConfigInsert,
  BlocoConfigRow,
  BlocoTipo,
} from "@/types/database";
import type { BlocoConfig } from "@/types/domain";

// ---------------------------------------------------------------------
// Mapeadores e tipos de entrada
// ---------------------------------------------------------------------

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

/** Entrada de upsert (camelCase). Chaves opcionais usam defaults do banco. */
export interface BlocoConfigUpsertInput {
  escopo: string;
  tipo: BlocoTipo;
  visivel?: boolean;
  ordem?: number;
  banda?: BlocoBanda | null;
  valor?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------

/**
 * GET por escopo. Quando `escopo` e informado, retorna a entrada exata E suas
 * descendentes hierarquicas (`escopo.*`). Filtro opcional por `tipo`.
 * A RLS ja restringe ao usuario autenticado.
 */
export async function getBlocoConfig(
  escopo?: string,
  tipo?: BlocoTipo,
): Promise<BlocoConfig[]> {
  const client = db();
  let q = client.from("bloco_config").select("*");
  if (escopo) q = q.or(`escopo.eq.${escopo},escopo.like.${escopo}.%`);
  if (tipo) q = q.eq("tipo", tipo);
  const { data, error } = await q.order("ordem", { ascending: true });
  if (error) throw new Error(`Falha ao ler bloco_config: ${error.message}`);
  return (data ?? []).map(rowToBlocoConfig);
}

// ---------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------

/** Escrita low-level: upsert de linhas ja carimbadas (user_id/org_id). */
export async function upsertBlocoConfigRows(
  client: TypedClient,
  rows: BlocoConfigInsert[],
): Promise<BlocoConfig[]> {
  if (rows.length === 0) return [];
  const { data, error } = await client
    .from("bloco_config")
    .upsert(rows, { onConflict: "user_id,org_id,escopo,tipo" })
    .select("*");
  if (error) throw new Error(`Falha ao gravar bloco_config: ${error.message}`);
  return (data ?? []).map(rowToBlocoConfig);
}

/** Upsert em lote de visibilidade/ordem/banda/valor por escopo+tipo. */
export async function upsertBlocoConfigLote(
  items: BlocoConfigUpsertInput[],
): Promise<BlocoConfig[]> {
  if (items.length === 0) return [];
  const client = db();
  const ctx = await resolveUserOrg(client);
  const rows: BlocoConfigInsert[] = items.map((it) => {
    const row: BlocoConfigInsert = {
      user_id: ctx.userId,
      org_id: ctx.orgId,
      escopo: it.escopo,
      tipo: it.tipo,
    };
    if (it.visivel !== undefined) row.visivel = it.visivel;
    if (it.ordem !== undefined) row.ordem = it.ordem;
    if (it.banda !== undefined) row.banda = it.banda;
    if (it.valor !== undefined) row.valor = it.valor;
    return row;
  });
  return upsertBlocoConfigRows(client, rows);
}

/**
 * Prune de orfaos (SPEC 2.3.2). Implementado em APP CODE (mutation), nao em
 * trigger: o migrador / a UI calculam os ids fora do catalogo canonico e
 * delegam a remocao fisica aqui. No-op para lista vazia.
 */
export async function pruneBlocoConfig(orfaoIds: string[]): Promise<number> {
  if (orfaoIds.length === 0) return 0;
  const client = db();
  const ctx = await resolveUserOrg(client);
  const { error } = await client
    .from("bloco_config")
    .delete()
    .eq("user_id", ctx.userId)
    .in("id", orfaoIds);
  if (error) throw new Error(`Falha ao podar bloco_config: ${error.message}`);
  return orfaoIds.length;
}
