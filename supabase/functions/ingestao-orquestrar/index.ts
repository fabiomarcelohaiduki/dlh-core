// =====================================================================
// Edge Function: ingestao-orquestrar  ->  POST /ingestao/orquestrar
// Relogio GLOBAL do ciclo de coleta em BLOCOS (US-03/RF-20, decisao 06/06).
//
//   - Disparada pelo pg_cron. Autentica por chamada interna: Bearer
//     service_role OU segredo de sistema no Vault (header X-Cron-Secret).
//     NAO usa sessao humana. Corpo vazio.
//   - SINGLE-FLIGHT: no maximo UMA execucao 'em_andamento' por vez. Quando ha
//     uma, AVANCA o seu checkpoint (um bloco) e nao inicia outra.
//   - Retomada automatica: execucoes em 'erro' com checkpoint valido voltam a
//     'em_andamento' (respeitando single-flight) ate NOMUS_MAX_RETOMADAS;
//     estouro do teto fica em 'erro' aguardando acao manual.
//   - Quando ocioso e ha fonte DUE (pela frequencia de config_agendamento),
//     inicia a proxima por ordem (incrementais antes; backfill por ultimo).
//   - Responde SINCRONO { acao, execucao_id, fonte, recurso } com
//     acao in avancou|iniciou|ocioso|concluiu. Reusa pg_cron/config_agendamento
//     (nenhum agendador novo).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { getFonteSecret, getServiceSecret } from "../_shared/vault.ts";
import { createConnector } from "../_shared/effecti-connector.ts";
import { type NomusConnector, type NomusRecursoConfig } from "../_shared/nomus-connector.ts";
import { createEmbeddingProvider } from "../_shared/embeddings.ts";
import { createTextExtractor } from "../_shared/file-processing.ts";
import { runPipeline } from "../_shared/pipeline.ts";
import {
  buildInitialCheckpoint,
  type CheckpointModo,
  janelaMovel,
  type NomusCheckpoint,
  nomusMaxRetomadas,
  parseCheckpoint,
  runNomusBlock,
} from "../_shared/nomus-pipeline.ts";
import type { OrquestrarResponse } from "../_shared/types.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

// Nome deterministico do segredo de sistema do cron no Vault (rotacionavel).
const CRON_SECRET_NAME = "CRON_DISPATCH_SECRET" as const;
const DEFAULT_JANELA_DIAS = 7;
const NOMUS_RECURSO = "processos" as const;

interface FonteRow {
  id: string;
  tipo: string;
  endpoint_base: string;
  ordem: number;
}

interface ExecRow {
  id: string;
  fonte_id: string | null;
  recurso: string | null;
  status: string;
  checkpoint: unknown;
  inicio: string;
}

interface ConfigRow {
  janela_dias: number | null;
  data_inicial: string | null;
  recursos: Record<string, unknown> | null;
  modalidades: string[] | null;
  portais: string[] | null;
}

// ---------------------------------------------------------------------
// Autenticacao da chamada interna (service_role OU X-Cron-Secret no Vault)
// ---------------------------------------------------------------------

async function assertInternalAuth(req: Request): Promise<void> {
  const bearer = extractBearerToken(req);
  const env = getEnv();
  if (bearer && bearer === env.serviceRoleKey) return;

  const provided = req.headers.get("X-Cron-Secret")?.trim() ?? "";
  const expected = (await getServiceSecret(CRON_SECRET_NAME))?.trim() ?? "";
  if (expected && provided && timingSafeEqual(provided, expected)) return;

  throw new HttpError(401, "cron_unauthorized", "chamada interna nao autorizada");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------
// Helpers de config / fonte
// ---------------------------------------------------------------------

async function loadConfig(
  service: ReturnType<typeof createServiceClient>,
  fonteId: string,
): Promise<ConfigRow | null> {
  const { data, error } = await service
    .from("config_ingestao")
    .select("janela_dias, data_inicial, recursos, modalidades, portais")
    .eq("fonte_id", fonteId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar a config de ingestao");
  }
  return (data ?? null) as ConfigRow | null;
}

function readRecursoConfig(
  recursos: Record<string, unknown> | null,
  recurso: string,
): NomusRecursoConfig {
  const raw = recursos?.[recurso];
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const tipos = Array.isArray(o.tipos_ativos)
    ? o.tipos_ativos.filter((v): v is string => typeof v === "string")
    : undefined;
  const etapas = Array.isArray(o.etapas_terminais)
    ? o.etapas_terminais.filter((v): v is string => typeof v === "string")
    : undefined;
  return {
    ativo: typeof o.ativo === "boolean" ? o.ativo : undefined,
    tipos_ativos: tipos,
    usa_filtro_data_alteracao: typeof o.usa_filtro_data_alteracao === "boolean"
      ? o.usa_filtro_data_alteracao
      : undefined,
    etapas_terminais: etapas,
  };
}

function buildNomusConnector(fonte: FonteRow, token: string, config: ConfigRow | null): {
  connector: NomusConnector;
  recursoConfig: NomusRecursoConfig;
  tiposAtivos: string[];
  janelaDias: number;
} {
  const recursoConfig = readRecursoConfig(config?.recursos ?? null, NOMUS_RECURSO);
  const tiposAtivos = recursoConfig.tipos_ativos ?? [];
  const janelaDias = config?.janela_dias ?? DEFAULT_JANELA_DIAS;
  const connector = createConnector("nomus", {
    endpointBase: fonte.endpoint_base,
    token,
    recurso: NOMUS_RECURSO,
    recursoConfig,
    janelaDias,
  }) as NomusConnector;
  return { connector, recursoConfig, tiposAtivos, janelaDias };
}

/** Intervalo (ms) entre ciclos para uma frequencia; null em 'manual'. */
function intervalMs(frequencia: string): number | null {
  switch (frequencia) {
    case "horaria":
      return 60 * 60 * 1000;
    case "diaria":
      return 24 * 60 * 60 * 1000;
    case "semanal":
      return 7 * 24 * 60 * 60 * 1000;
    case "mensal":
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return null; // 'manual' (ou desconhecido): nao auto-inicia ciclo.
  }
}

/** DUE: a fonte deve iniciar um novo ciclo? (baseado na ultima execucao). */
async function isFonteDue(
  service: ReturnType<typeof createServiceClient>,
  fonteId: string,
  frequencia: string,
): Promise<boolean> {
  const interval = intervalMs(frequencia);
  if (interval === null) return false;
  const { data } = await service
    .from("execucoes")
    .select("inicio")
    .eq("fonte_id", fonteId)
    .order("inicio", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = data as { inicio?: string | null } | null;
  if (!last?.inicio) return true;
  const lastMs = Date.parse(last.inicio);
  if (!Number.isFinite(lastMs)) return true;
  return Date.now() - lastMs >= interval;
}

// ---------------------------------------------------------------------
// Acoes do tique
// ---------------------------------------------------------------------

/** Avanca UM bloco de uma execucao Nomus em_andamento (single-flight). */
async function advanceNomus(
  service: ReturnType<typeof createServiceClient>,
  exec: ExecRow,
  checkpoint: NomusCheckpoint,
): Promise<OrquestrarResponse> {
  const fonte = await loadFonte(service, exec.fonte_id);
  if (!fonte) {
    return { acao: "ocioso", execucao_id: exec.id, fonte: null, recurso: exec.recurso };
  }
  const token = await getFonteSecret(fonte.id);
  if (!token) {
    return { acao: "ocioso", execucao_id: exec.id, fonte: fonte.tipo, recurso: exec.recurso };
  }
  const config = await loadConfig(service, fonte.id);
  const { connector, tiposAtivos } = buildNomusConnector(fonte, token, config);
  const env = getEnv();
  const embeddingProvider = env.embeddingsEndpoint ? createEmbeddingProvider() : undefined;

  const outcome = await runNomusBlock(
    { db: service, connector, embeddingProvider, fonteId: fonte.id },
    { execucaoId: exec.id, recurso: exec.recurso ?? NOMUS_RECURSO, tiposAtivos, checkpoint },
  );

  return {
    acao: outcome.concluido ? "concluiu" : "avancou",
    execucao_id: exec.id,
    fonte: fonte.tipo,
    recurso: exec.recurso ?? NOMUS_RECURSO,
  };
}

/** Retoma uma execucao Nomus em 'erro' (incrementa tentativas) e avanca. */
async function resumeNomus(
  service: ReturnType<typeof createServiceClient>,
  exec: ExecRow,
  checkpoint: NomusCheckpoint,
): Promise<OrquestrarResponse> {
  const retomado: NomusCheckpoint = {
    ...checkpoint,
    tentativas_retomada: checkpoint.tentativas_retomada + 1,
  };
  // Marca em_andamento ja com a tentativa contabilizada (single-flight).
  const { error } = await service
    .from("execucoes")
    .update({ status: "em_andamento", etapa_atual: "coleta", checkpoint: retomado })
    .eq("id", exec.id);
  if (error) {
    throw new HttpError(500, "execucao_update_failed", "falha ao retomar a execucao");
  }
  return await advanceNomus(service, exec, retomado);
}

/** Inicia uma nova coleta para a fonte (Nomus em blocos; Effecti completo). */
async function startFonte(
  service: ReturnType<typeof createServiceClient>,
  fonte: FonteRow,
): Promise<OrquestrarResponse> {
  const token = await getFonteSecret(fonte.id);
  if (!token) {
    return { acao: "ocioso", execucao_id: null, fonte: fonte.tipo, recurso: null };
  }
  const config = await loadConfig(service, fonte.id);

  if (fonte.tipo === "nomus") {
    return await startNomus(service, fonte, token, config);
  }
  return await startEffecti(service, fonte, token, config);
}

async function startNomus(
  service: ReturnType<typeof createServiceClient>,
  fonte: FonteRow,
  token: string,
  config: ConfigRow | null,
): Promise<OrquestrarResponse> {
  const { connector, tiposAtivos, janelaDias } = buildNomusConnector(fonte, token, config);

  const until = new Date();
  let since: Date;
  let modo: CheckpointModo;
  if (config?.data_inicial) {
    since = new Date(`${config.data_inicial}T00:00:00.000Z`);
    modo = "backfill";
  } else {
    since = janelaMovel(janelaDias, until);
    modo = "incremental";
  }
  const checkpoint = buildInitialCheckpoint(modo, since, until);

  const { data: execucao, error: insError } = await service
    .from("execucoes")
    .insert({
      inicio: new Date().toISOString(),
      gatilho: "agendada",
      janela_dias: janelaDias,
      fonte_id: fonte.id,
      recurso: NOMUS_RECURSO,
      tipo_alvo: tiposAtivos.length > 0 ? tiposAtivos.join(", ") : null,
      checkpoint,
      novos: 0,
      alterados: 0,
      status: "em_andamento",
      etapa_atual: "coleta",
      total_processar: 0,
      processados_sucesso: 0,
      processados_erro: 0,
      pendentes: 0,
    })
    .select("id")
    .single();
  if (insError || !execucao) {
    throw new HttpError(500, "execucao_insert_failed", "falha ao criar a execucao");
  }
  const execucaoId = String((execucao as { id: string }).id);

  const env = getEnv();
  const embeddingProvider = env.embeddingsEndpoint ? createEmbeddingProvider() : undefined;

  // Primeiro bloco sincrono: o resultado define a acao (iniciou/concluiu).
  const outcome = await runNomusBlock(
    { db: service, connector, embeddingProvider, fonteId: fonte.id },
    { execucaoId, recurso: NOMUS_RECURSO, tiposAtivos, checkpoint },
  );

  return {
    acao: outcome.concluido ? "concluiu" : "iniciou",
    execucao_id: execucaoId,
    fonte: fonte.tipo,
    recurso: NOMUS_RECURSO,
  };
}

async function startEffecti(
  service: ReturnType<typeof createServiceClient>,
  fonte: FonteRow,
  token: string,
  config: ConfigRow | null,
): Promise<OrquestrarResponse> {
  const janelaDias = config?.janela_dias ?? DEFAULT_JANELA_DIAS;
  const sinceDate = janelaMovel(janelaDias);
  const modalidades = config?.modalidades ?? undefined;
  const portais = config?.portais ?? undefined;

  const { data: execucao, error: insError } = await service
    .from("execucoes")
    .insert({
      inicio: new Date().toISOString(),
      gatilho: "agendada",
      janela_dias: janelaDias,
      fonte_id: fonte.id,
      novos: 0,
      alterados: 0,
      status: "em_andamento",
      etapa_atual: "coleta",
      total_processar: 0,
      processados_sucesso: 0,
      processados_erro: 0,
      pendentes: 0,
    })
    .select("id")
    .single();
  if (insError || !execucao) {
    throw new HttpError(500, "execucao_insert_failed", "falha ao criar a execucao");
  }
  const execucaoId = String((execucao as { id: string }).id);

  const connector = createConnector(fonte.tipo, { endpointBase: fonte.endpoint_base, token });
  const env = getEnv();
  const embeddingProvider = env.embeddingsEndpoint ? createEmbeddingProvider() : undefined;
  const textExtractor = env.fileExtractionEndpoint ? createTextExtractor() : undefined;

  const pipelinePromise = runPipeline(
    { db: service, connector, embeddingProvider, textExtractor },
    { execucaoId, sinceDate, modalidades, portais },
  ).catch((err) => {
    console.error("[orquestrar] pipeline effecti falhou", {
      execucaoId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(pipelinePromise);
  }

  return { acao: "iniciou", execucao_id: execucaoId, fonte: fonte.tipo, recurso: null };
}

async function loadFonte(
  service: ReturnType<typeof createServiceClient>,
  fonteId: string | null,
): Promise<FonteRow | null> {
  if (!fonteId) return null;
  const { data } = await service
    .from("fontes")
    .select("id, tipo, endpoint_base, ordem")
    .eq("id", fonteId)
    .maybeSingle();
  return (data ?? null) as FonteRow | null;
}

// ---------------------------------------------------------------------
// Tique: orquestra um unico passo do ciclo (single-flight)
// ---------------------------------------------------------------------

async function tick(
  service: ReturnType<typeof createServiceClient>,
  frequencia: string,
): Promise<OrquestrarResponse> {
  const ocioso: OrquestrarResponse = {
    acao: "ocioso",
    execucao_id: null,
    fonte: null,
    recurso: null,
  };

  // 1. Single-flight: ja ha execucao em_andamento? avanca a dela (Nomus) ou
  //    deixa o Effecti concluir sozinho (ocioso).
  const { data: ativa, error: ativaErr } = await service
    .from("execucoes")
    .select("id, fonte_id, recurso, status, checkpoint, inicio")
    .eq("status", "em_andamento")
    .order("inicio", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (ativaErr) {
    throw new HttpError(500, "execucao_query_failed", "falha ao verificar execucoes em andamento");
  }
  if (ativa) {
    const exec = ativa as ExecRow;
    const checkpoint = parseCheckpoint(exec.checkpoint);
    if (exec.recurso && checkpoint) {
      return await advanceNomus(service, exec, checkpoint);
    }
    // Effecti (sem checkpoint): roda seu pipeline proprio; nada a avancar.
    return { acao: "ocioso", execucao_id: exec.id, fonte: null, recurso: exec.recurso };
  }

  // 2. Retomada automatica de execucao em 'erro' com checkpoint valido, dentro
  //    do teto NOMUS_MAX_RETOMADAS (respeita single-flight: ja sabemos que nao
  //    ha em_andamento).
  const maxRetomadas = nomusMaxRetomadas();
  const { data: comErro, error: erroErr } = await service
    .from("execucoes")
    .select("id, fonte_id, recurso, status, checkpoint, inicio")
    .eq("status", "erro")
    .not("recurso", "is", null)
    .order("inicio", { ascending: true })
    .limit(20);
  if (erroErr) {
    throw new HttpError(500, "execucao_query_failed", "falha ao verificar execucoes em erro");
  }
  for (const row of (comErro ?? []) as ExecRow[]) {
    const checkpoint = parseCheckpoint(row.checkpoint);
    if (!checkpoint) continue;
    if (checkpoint.fase === "concluido") continue;
    if (checkpoint.tentativas_retomada >= maxRetomadas) continue; // aguarda manual.
    return await resumeNomus(service, row, checkpoint);
  }

  // 3. Inicia a proxima fonte DUE por ordem. Incrementais antes; backfill por
  //    ultimo (prioridade menor).
  const { data: fontes, error: fontesErr } = await service
    .from("fontes")
    .select("id, tipo, endpoint_base, ordem")
    .eq("ativa", true)
    .order("ordem", { ascending: true });
  if (fontesErr) {
    throw new HttpError(500, "fontes_query_failed", "falha ao listar fontes ativas");
  }

  const incrementais: FonteRow[] = [];
  const backfills: FonteRow[] = [];
  for (const fonte of (fontes ?? []) as FonteRow[]) {
    const config = await loadConfig(service, fonte.id);
    if (config?.data_inicial) backfills.push(fonte);
    else incrementais.push(fonte);
  }

  for (const fonte of [...incrementais, ...backfills]) {
    if (await isFonteDue(service, fonte.id, frequencia)) {
      return await startFonte(service, fonte);
    }
  }

  // 4. Nada a fazer neste tique.
  return ocioso;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    await assertInternalAuth(req);

    const service = createServiceClient();

    // Ciclo desligado no painel => ocioso (sem criar execucoes).
    const { data: cfg, error: cfgErr } = await service
      .from("config_agendamento")
      .select("ativo, frequencia")
      .limit(1)
      .maybeSingle();
    if (cfgErr) {
      throw new HttpError(500, "agendamento_query_failed", "falha ao ler config_agendamento");
    }
    const agendamento = (cfg ?? null) as { ativo?: boolean; frequencia?: string } | null;
    if (!agendamento || agendamento.ativo !== true) {
      const body: OrquestrarResponse = {
        acao: "ocioso",
        execucao_id: null,
        fonte: null,
        recurso: null,
      };
      return jsonResponse(body, 200);
    }

    const body = await tick(service, agendamento.frequencia ?? "manual");
    return jsonResponse(body, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "ingestao-orquestrar" });
  }
}

getEnv();

Deno.serve(handler);
