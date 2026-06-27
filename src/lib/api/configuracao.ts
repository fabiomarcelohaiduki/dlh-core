// =====================================================================
// API layer — preferencias do usuario (tabela `configuracao`, SPEC 2.1.4).
//
// Singleton por (user_id, org_id). Persistencia AO VIVO (sem botao Salvar):
// cada alteracao e um PATCH imediato. A RLS restringe a `user_id = auth.uid()`;
// as escritas carimbam user_id/org_id via `resolveUserOrg`.
//
// `bootstrapConfiguracao` e o ponto de entrada do primeiro acesso: garante a
// linha default (SPEC 2.4.2) e dispara o migrador de leitura unica
// localStorage -> Supabase (cfg.ts, SPEC 2.4.3) de forma idempotente.
// =====================================================================

import { db, resolveUserOrg, type TypedClient, type UserOrg } from "@/lib/api/session";
import { TEMA_IDS } from "@/lib/api/tema";
import { migrarLegado } from "@/lib/cfg";
import type {
  ConfiguracaoInsert,
  ConfiguracaoRow,
  ConfiguracaoUpdate,
} from "@/types/database";
import type { Configuracao } from "@/types/domain";

// ---------------------------------------------------------------------
// Mapeadores Row <-> Domain
// ---------------------------------------------------------------------

function rowToConfiguracao(r: ConfiguracaoRow): Configuracao {
  return {
    id: r.id,
    userId: r.user_id,
    orgId: r.org_id,
    areaInicial: r.area_inicial,
    linhasCompactas: r.linhas_compactas,
    destacarPendencias: r.destacar_pendencias,
    temaId: r.tema_id,
    densidade: r.densidade,
    reduzirMovimento: r.reduzir_movimento,
    highlightPendencias: r.highlight_pendencias,
    defaultArea: r.default_area,
    tz: r.tz,
    dateFmt: r.date_fmt,
    numFmt: r.num_fmt,
    notifyAlerts: r.notify_alerts,
    notifyIngest: r.notify_ingest,
    notifyDeadline: r.notify_deadline,
    notifyDigest: r.notify_digest,
    autoSync: r.auto_sync,
    syncFreq: r.sync_freq,
    sessionTimeout: r.session_timeout,
    sessionWarn: r.session_warn,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Converte um patch de dominio (camelCase) em ConfiguracaoUpdate (snake_case),
 * incluindo SOMENTE as chaves explicitamente presentes (patch parcial). */
export function domainPatchToRow(p: Partial<Configuracao>): ConfiguracaoUpdate {
  const row: ConfiguracaoUpdate = {};
  if (p.areaInicial !== undefined) row.area_inicial = p.areaInicial;
  if (p.linhasCompactas !== undefined) row.linhas_compactas = p.linhasCompactas;
  if (p.destacarPendencias !== undefined) row.destacar_pendencias = p.destacarPendencias;
  if (p.temaId !== undefined) row.tema_id = p.temaId;
  if (p.densidade !== undefined) row.densidade = p.densidade;
  if (p.reduzirMovimento !== undefined) row.reduzir_movimento = p.reduzirMovimento;
  if (p.highlightPendencias !== undefined) row.highlight_pendencias = p.highlightPendencias;
  if (p.defaultArea !== undefined) row.default_area = p.defaultArea;
  if (p.tz !== undefined) row.tz = p.tz;
  if (p.dateFmt !== undefined) row.date_fmt = p.dateFmt;
  if (p.numFmt !== undefined) row.num_fmt = p.numFmt;
  if (p.notifyAlerts !== undefined) row.notify_alerts = p.notifyAlerts;
  if (p.notifyIngest !== undefined) row.notify_ingest = p.notifyIngest;
  if (p.notifyDeadline !== undefined) row.notify_deadline = p.notifyDeadline;
  if (p.notifyDigest !== undefined) row.notify_digest = p.notifyDigest;
  if (p.autoSync !== undefined) row.auto_sync = p.autoSync;
  if (p.syncFreq !== undefined) row.sync_freq = p.syncFreq;
  if (p.sessionTimeout !== undefined) row.session_timeout = p.sessionTimeout;
  if (p.sessionWarn !== undefined) row.session_warn = p.sessionWarn;
  return row;
}

// ---------------------------------------------------------------------
// Operacoes internas (recebem client + ctx ja resolvidos)
// ---------------------------------------------------------------------

async function selectConfiguracao(
  client: TypedClient,
  userId: string,
): Promise<ConfiguracaoRow | null> {
  const { data, error } = await client
    .from("configuracao")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao ler configuracao: ${error.message}`);
  return data ?? null;
}

/** Garante a linha default (SPEC 2.4.2): tema LionClaw + densidade confortavel.
 * Idempotente via upsert no conflito (user_id, org_id). */
async function ensureConfiguracao(
  client: TypedClient,
  ctx: UserOrg,
): Promise<Configuracao> {
  const existing = await selectConfiguracao(client, ctx.userId);
  if (existing) return rowToConfiguracao(existing);

  const insert: ConfiguracaoInsert = {
    user_id: ctx.userId,
    org_id: ctx.orgId,
    tema_id: TEMA_IDS.lionclaw,
    densidade: "confortavel",
  };
  const { data, error } = await client
    .from("configuracao")
    .upsert(insert, { onConflict: "user_id,org_id" })
    .select("*")
    .single();
  if (error) throw new Error(`Falha ao criar configuracao default: ${error.message}`);
  return rowToConfiguracao(data);
}

async function applyPatch(
  client: TypedClient,
  ctx: UserOrg,
  row: ConfiguracaoUpdate,
): Promise<Configuracao> {
  if (Object.keys(row).length === 0) {
    const cur = await selectConfiguracao(client, ctx.userId);
    if (!cur) throw new Error("Configuracao inexistente para patch.");
    return rowToConfiguracao(cur);
  }
  const { data, error } = await client
    .from("configuracao")
    .update(row)
    .eq("user_id", ctx.userId)
    .select("*")
    .single();
  if (error) throw new Error(`Falha ao atualizar configuracao: ${error.message}`);
  return rowToConfiguracao(data);
}

// ---------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------

/** GET — configuracao do usuario autenticado (ou null se ainda nao existe). */
export async function getConfiguracao(): Promise<Configuracao | null> {
  const client = db();
  const ctx = await resolveUserOrg(client);
  const row = await selectConfiguracao(client, ctx.userId);
  return row ? rowToConfiguracao(row) : null;
}

/** PATCH — atualiza preferencias do usuario (live, sem botao Salvar). */
export async function patchConfiguracao(
  patch: Partial<Configuracao>,
): Promise<Configuracao> {
  const client = db();
  const ctx = await resolveUserOrg(client);
  return applyPatch(client, ctx, domainPatchToRow(patch));
}

/**
 * Bootstrap do primeiro acesso autenticado:
 *  1. garante a configuracao default (SPEC 2.4.2);
 *  2. roda o migrador de leitura unica localStorage -> Supabase (SPEC 2.4.3),
 *     que escreve bloco_config e devolve o patch de configuracao a aplicar.
 *
 * O migrador e idempotente: apos a primeira passagem ele descarta as chaves
 * legadas (safeRemove), de modo que execucoes subsequentes nao reimportam nada.
 */
export async function bootstrapConfiguracao(): Promise<Configuracao> {
  const client = db();
  const ctx = await resolveUserOrg(client);

  let cfg = await ensureConfiguracao(client, ctx);

  const migracao = await migrarLegado(client, ctx);
  if (migracao.migrou && migracao.configPatch) {
    cfg = await applyPatch(client, ctx, migracao.configPatch);
  }

  return cfg;
}
