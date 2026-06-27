// =====================================================================
// Camada de dados (db/) — preferencias do usuario (tabela `configuracao`,
// SPEC 2.1.4). Singleton por (user_id, org_id).
//
// Persistencia canonica via Supabase client direto com RLS (D-BE-01). NAO ha
// endpoint REST/Route Handler. As escritas sao AO VIVO (sem botao "Salvar"):
// cada alteracao e um UPSERT parcial. A RLS restringe a `user_id = auth.uid()`
// + org da membership; o par (userId, orgId) e carimbado explicitamente.
// =====================================================================

import { db, type TypedClient } from "@/lib/api/session";
import { TEMA_IDS } from "@/lib/db/tema";
import { getBlocoConfig } from "@/lib/db/bloco-config";
import { migrarLegado } from "@/lib/db/cfg";
import type {
  ConfiguracaoInsert,
  ConfiguracaoRow,
  ConfiguracaoUpdate,
} from "@/types/database";
import type { BlocoConfig, Configuracao } from "@/types/domain";

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

/**
 * Converte um patch de dominio (camelCase) em ConfiguracaoUpdate (snake_case),
 * incluindo SOMENTE as chaves explicitamente presentes (patch parcial). Campos
 * de identidade (id/userId/orgId/createdAt/updatedAt) sao ignorados.
 */
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
// Leitura interna
// ---------------------------------------------------------------------

async function selectConfiguracao(
  client: TypedClient,
  userId: string,
  orgId: string,
): Promise<ConfiguracaoRow | null> {
  const { data, error } = await client
    .from("configuracao")
    .select("*")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao ler configuracao: ${error.message}`);
  return data ?? null;
}

// ---------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------

/**
 * UPSERT parcial da configuracao singleton por (user_id, org_id). Cria a linha
 * com defaults do banco quando ainda nao existe e atualiza apenas as colunas
 * presentes em `partial` quando ja existe (persistencia ao vivo). O trigger
 * `set_updated_at` carimba `updated_at` em cada update.
 */
export async function patchConfiguracao(
  userId: string,
  orgId: string,
  partial: Partial<Configuracao>,
  client: TypedClient = db(),
): Promise<Configuracao> {
  const insert: ConfiguracaoInsert = {
    ...domainPatchToRow(partial),
    user_id: userId,
    org_id: orgId,
  };
  const { data, error } = await client
    .from("configuracao")
    .upsert(insert, { onConflict: "user_id,org_id" })
    .select("*")
    .single();
  if (error) throw new Error(`Falha ao salvar configuracao: ${error.message}`);
  return rowToConfiguracao(data);
}

/**
 * Garante a linha default (SPEC 2.4.2): tema LionClaw + densidade confortavel.
 * Idempotente — retorna a existente quando ja houver.
 */
async function ensureConfiguracao(
  userId: string,
  orgId: string,
  client: TypedClient,
): Promise<Configuracao> {
  const existing = await selectConfiguracao(client, userId, orgId);
  if (existing) return rowToConfiguracao(existing);
  return patchConfiguracao(
    userId,
    orgId,
    { temaId: TEMA_IDS.lionclaw, densidade: "confortavel" },
    client,
  );
}

/** Resultado do bootstrap: preferencias + blocos do usuario/org. */
export interface BootstrapResult {
  configuracao: Configuracao;
  blocos: BlocoConfig[];
}

/**
 * Bootstrap do primeiro acesso autenticado (D-BE-05 / D-DB-05):
 *  1. garante a linha de configuracao default (SPEC 2.4.2);
 *  2. dispara `migrarLegado` (idempotente, no-op fora do browser), importando o
 *     estado legado do localStorage para o Supabase. O writer de configuracao e
 *     injetado para preservar a separacao de camadas e a tolerancia EC-07;
 *  3. recarrega configuracao + bloco_config ja consolidados.
 */
export async function bootstrapConfiguracao(
  userId: string,
  orgId: string,
  client: TypedClient = db(),
): Promise<BootstrapResult> {
  let configuracao = await ensureConfiguracao(userId, orgId, client);

  const migracao = await migrarLegado(
    userId,
    orgId,
    (patch) => patchConfiguracao(userId, orgId, patch, client),
    client,
  );

  // A migracao pode ter alterado a configuracao (prefs/tema): recarrega.
  if (migracao.migrou) {
    const reloaded = await selectConfiguracao(client, userId, orgId);
    if (reloaded) configuracao = rowToConfiguracao(reloaded);
  }

  const blocos = await getBlocoConfig(userId, orgId, undefined, undefined, client);
  return { configuracao, blocos };
}
