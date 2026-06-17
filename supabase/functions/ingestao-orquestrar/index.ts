// =====================================================================
// Edge Function: ingestao-orquestrar  ->  POST /ingestao/orquestrar
// Relogio POR FONTE do ciclo de coleta em BLOCOS (decisao 09/06: substitui o
// ciclo GLOBAL). Cada fonte tem seu job pg_cron coleta-<tipo>.
//
//   - Disparada pelo pg_cron. Autentica por chamada interna: Bearer
//     service_role OU segredo de sistema no Vault (header X-Cron-Secret).
//     NAO usa sessao humana. Corpo { "fonte": "<tipo>" } escopa a fonte.
//   - SINGLE-FLIGHT ESCOPADO A FONTE (lock por fonte): no maximo UMA execucao
//     'em_andamento' POR FONTE. Quando ha uma desta fonte, AVANCA o seu
//     checkpoint (um bloco) e nao inicia outra; outras fontes nao sao barradas.
//   - Retomada automatica: execucoes em 'erro' DESTA fonte com checkpoint valido
//     voltam a 'em_andamento' ate NOMUS_MAX_RETOMADAS; estouro fica aguardando
//     acao manual.
//   - Quando ocioso e a fonte esta DUE (pela frequencia da config_ingestao da
//     fonte), inicia uma nova coleta desta fonte.
//   - Responde SINCRONO { acao, execucao_id, fonte, recurso } com
//     acao in avancou|iniciou|ocioso|concluiu. Agendamento mora na
//     config_ingestao da fonte; pg_cron coleta-<tipo> e o disparador.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { getFonteSecret, getServiceSecret } from "../_shared/vault.ts";
import { createConnector, EffectiConnector } from "../_shared/effecti-connector.ts";
import { type NomusConnector, type NomusRecursoConfig } from "../_shared/nomus-connector.ts";
import { createEmbeddingProvider } from "../_shared/embeddings.ts";
import {
  buildInitialCheckpoint,
  type CheckpointModo,
  janelaMovel,
  type NomusCheckpoint,
  nomusMaxRetomadas,
  parseCheckpoint,
  runNomusBlock,
} from "../_shared/nomus-pipeline.ts";
import {
  buildInitialEffectiCheckpoint,
  type EffectiCheckpoint,
  effectiMaxRetomadas,
  parseEffectiCheckpoint,
  runEffectiBlock,
} from "../_shared/effecti-pipeline.ts";
import type { OrquestrarResponse } from "../_shared/types.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

// Nome deterministico do segredo de sistema do cron no Vault (rotacionavel).
const CRON_SECRET_NAME = "CRON_DISPATCH_SECRET" as const;
const DEFAULT_JANELA_DIAS = 7;
const NOMUS_RECURSO = "processos" as const;

// Teto de heartbeat do Effecti: execucao ativa sem updates (updated_at) por
// mais que isso => orfa (o Edge Runtime morreu no meio do pipeline). O
// pipeline vivo toca a linha a cada item, entao o teto pode ser folgado sem
// risco de matar um run legitimo. Configuravel via Edge secret; default 10 min.
const EFFECTI_ORPHAN_STALE_MS = Number(Deno.env.get("EFFECTI_ORPHAN_STALE_MS")) ||
  10 * 60 * 1000;

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
  updated_at?: string | null;
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
  if (bearer && timingSafeEqual(bearer, env.serviceRoleKey)) return;

  const provided = req.headers.get("X-Cron-Secret")?.trim() ?? "";
  const expected = (await getServiceSecret(CRON_SECRET_NAME))?.trim() ?? "";
  if (expected && provided && timingSafeEqual(provided, expected)) return;

  throw new HttpError(401, "cron_unauthorized", "chamada interna nao autorizada");
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

// Tolerancia anti-drift do DUE. O pg_cron coleta-<tipo> e o relogio mestre (um
// disparo por periodo). Comparar com o intervalo EXATO fazia o agendado PULAR o
// dia quando o inicio da ultima execucao caia poucos segundos abaixo de 24h
// (drift cron->Edge->insert acumula a cada dia) ou quando uma coleta MANUAL
// rodava mais tarde no dia anterior (deslocava a "ultima execucao"). Liberar com
// metade do intervalo absorve o drift e a manual sem reabrir risco de
// duplicacao: o single-flight em_andamento ja barra o mesmo ciclo e o cron
// dispara so uma vez por periodo.
const DUE_TOLERANCIA = 0.5;

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
  return Date.now() - lastMs >= interval * DUE_TOLERANCIA;
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
  const until = new Date();
  const since = janelaMovel(janelaDias, until);
  const modalidades = config?.modalidades ?? undefined;
  const portais = config?.portais ?? undefined;
  // Coleta em BLOCOS com checkpoint (decisao 11/06): janela grande (ex.: 30
  // dias) nao cabe num unico waitUntil do Edge. Avanca UM bloco aqui e o
  // orquestrador avanca os seguintes nos tiques do ciclo (igual ao Nomus).
  const checkpoint = buildInitialEffectiCheckpoint(since, until);

  const { data: execucao, error: insError } = await service
    .from("execucoes")
    .insert({
      inicio: new Date().toISOString(),
      gatilho: "agendada",
      janela_dias: janelaDias,
      fonte_id: fonte.id,
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

  const connector = new EffectiConnector({ endpointBase: fonte.endpoint_base, token });
  const env = getEnv();
  const embeddingProvider = env.embeddingsEndpoint ? createEmbeddingProvider() : undefined;

  // Primeiro bloco sincrono: o resultado define a acao (iniciou/concluiu).
  const outcome = await runEffectiBlock(
    { db: service, connector, embeddingProvider, fonteId: fonte.id },
    { execucaoId, checkpoint, modalidades, portais },
  );

  return {
    acao: outcome.concluido ? "concluiu" : "iniciou",
    execucao_id: execucaoId,
    fonte: fonte.tipo,
    recurso: null,
  };
}

/** Avanca UM bloco de uma execucao Effecti em_andamento (single-flight). */
async function advanceEffecti(
  service: ReturnType<typeof createServiceClient>,
  exec: ExecRow,
  checkpoint: EffectiCheckpoint,
): Promise<OrquestrarResponse> {
  const fonte = await loadFonte(service, exec.fonte_id);
  if (!fonte) {
    return { acao: "ocioso", execucao_id: exec.id, fonte: null, recurso: null };
  }
  const token = await getFonteSecret(fonte.id);
  if (!token) {
    return { acao: "ocioso", execucao_id: exec.id, fonte: fonte.tipo, recurso: null };
  }
  const config = await loadConfig(service, fonte.id);
  const connector = new EffectiConnector({ endpointBase: fonte.endpoint_base, token });
  const env = getEnv();
  const embeddingProvider = env.embeddingsEndpoint ? createEmbeddingProvider() : undefined;

  const outcome = await runEffectiBlock(
    { db: service, connector, embeddingProvider, fonteId: fonte.id },
    {
      execucaoId: exec.id,
      checkpoint,
      modalidades: config?.modalidades ?? undefined,
      portais: config?.portais ?? undefined,
    },
  );

  return {
    acao: outcome.concluido ? "concluiu" : "avancou",
    execucao_id: exec.id,
    fonte: fonte.tipo,
    recurso: null,
  };
}

/** Retoma uma execucao Effecti em 'erro' (incrementa tentativas) e avanca. */
async function resumeEffecti(
  service: ReturnType<typeof createServiceClient>,
  exec: ExecRow,
  checkpoint: EffectiCheckpoint,
): Promise<OrquestrarResponse> {
  const retomado: EffectiCheckpoint = {
    ...checkpoint,
    tentativas_retomada: checkpoint.tentativas_retomada + 1,
  };
  const { error } = await service
    .from("execucoes")
    .update({ status: "em_andamento", etapa_atual: "coleta", checkpoint: retomado })
    .eq("id", exec.id);
  if (error) {
    throw new HttpError(500, "execucao_update_failed", "falha ao retomar a execucao");
  }
  return await advanceEffecti(service, exec, retomado);
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

/** Resolve a fonte pelo tipo (effecti|nomus); null quando nao cadastrada. */
async function loadFonteByTipo(
  service: ReturnType<typeof createServiceClient>,
  tipo: string,
): Promise<FonteRow | null> {
  const { data } = await service
    .from("fontes")
    .select("id, tipo, endpoint_base, ordem")
    .eq("tipo", tipo)
    .maybeSingle();
  return (data ?? null) as FonteRow | null;
}

/** Agendamento da fonte (config_ingestao): ativo + frequencia (defaults off). */
async function loadAgendamentoFonte(
  service: ReturnType<typeof createServiceClient>,
  fonteId: string,
): Promise<{ ativo: boolean; frequencia: string }> {
  const { data } = await service
    .from("config_ingestao")
    .select("agendamento_ativo, frequencia")
    .eq("fonte_id", fonteId)
    .maybeSingle();
  const row = (data ?? null) as { agendamento_ativo?: boolean; frequencia?: string } | null;
  return {
    ativo: row?.agendamento_ativo === true,
    frequencia: row?.frequencia ?? "manual",
  };
}

/**
 * Le o tipo da fonte do corpo { "fonte": "<tipo>" } que o job pg_cron
 * coleta-<tipo> envia. Corpo vazio/invalido => null (chamada sem escopo).
 */
async function parseFonteBody(req: Request): Promise<string | null> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const fonte = (raw as { fonte?: unknown }).fonte;
  return typeof fonte === "string" && fonte.length > 0 ? fonte : null;
}

// ---------------------------------------------------------------------
// Tique POR FONTE: orquestra um unico passo do ciclo da fonte (decisao 09/06).
// Single-flight ESCOPADO a fonte (lock por fonte): cada cron coleta-<tipo>
// dispara so a sua, sem barrar as demais.
// ---------------------------------------------------------------------

async function tickFonte(
  service: ReturnType<typeof createServiceClient>,
  fonte: FonteRow,
  frequencia: string,
): Promise<OrquestrarResponse> {
  const ocioso: OrquestrarResponse = {
    acao: "ocioso",
    execucao_id: null,
    fonte: fonte.tipo,
    recurso: null,
  };

  // 1. Single-flight escopado: ja ha execucao em_andamento DESTA fonte? avanca
  //    a dela (Nomus, por blocos) ou deixa o Effecti concluir sozinho (ocioso).
  const { data: ativa, error: ativaErr } = await service
    .from("execucoes")
    .select("id, fonte_id, recurso, status, checkpoint, inicio, updated_at")
    .eq("status", "em_andamento")
    .eq("fonte_id", fonte.id)
    .order("inicio", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (ativaErr) {
    throw new HttpError(500, "execucao_query_failed", "falha ao verificar execucoes em andamento");
  }
  if (ativa) {
    const exec = ativa as ExecRow;
    // Nomus: avanca um bloco pelo checkpoint do recurso.
    if (fonte.tipo === "nomus") {
      const checkpoint = parseCheckpoint(exec.checkpoint);
      if (checkpoint) {
        return await advanceNomus(service, exec, checkpoint);
      }
    }
    // Effecti (novo): tem checkpoint em blocos -> avanca um bloco aqui (igual
    // ao Nomus). Janela grande (ex.: 30 dias) nao cabe num unico tique.
    if (fonte.tipo === "effecti") {
      const checkpoint = parseEffectiCheckpoint(exec.checkpoint);
      if (checkpoint) {
        return await advanceEffecti(service, exec, checkpoint);
      }
    }
    // Effecti legado (sem checkpoint): rodou seu pipeline proprio em background.
    // Auto-cura de orfa: se o heartbeat (updated_at, bumpado a cada item) ficou
    // velho, o Edge Runtime morreu no meio -> fecha como erro e libera o lock;
    // senao, segue vivo e nada ha a avancar (ocioso). Heartbeat ilegivel =
    // conservador (trata como vivo, nunca mata um run legitimo).
    const heartbeatMs = Date.parse(exec.updated_at ?? exec.inicio);
    const vivo = !Number.isFinite(heartbeatMs) ||
      Date.now() - heartbeatMs <= EFFECTI_ORPHAN_STALE_MS;
    if (vivo) {
      return { acao: "ocioso", execucao_id: exec.id, fonte: fonte.tipo, recurso: exec.recurso };
    }
    await service
      .from("execucoes")
      .update({ status: "erro", etapa_atual: null, fim: new Date().toISOString() })
      .eq("id", exec.id)
      .eq("status", "em_andamento");
    console.warn("[orquestrar] orfa Effecti auto-curada (heartbeat velho)", {
      execucaoId: exec.id,
      fonte: fonte.tipo,
      updatedAt: exec.updated_at,
    });
    // Lock liberado: segue para retomada/inicio abaixo.
  }

  // 2. Retomada automatica de execucao em 'erro' DESTA fonte com checkpoint
  //    valido, dentro do teto de retomadas. Nomus e Effecti tem checkpoint;
  //    discrimina pelo tipo da fonte (execucoes Effecti legadas sem checkpoint
  //    sao ignoradas pelo parse e seguem aguardando acao manual).
  const { data: comErro, error: erroErr } = await service
    .from("execucoes")
    .select("id, fonte_id, recurso, status, checkpoint, inicio")
    .eq("status", "erro")
    .eq("fonte_id", fonte.id)
    .order("inicio", { ascending: true })
    .limit(20);
  if (erroErr) {
    throw new HttpError(500, "execucao_query_failed", "falha ao verificar execucoes em erro");
  }
  for (const row of (comErro ?? []) as ExecRow[]) {
    if (fonte.tipo === "nomus") {
      const checkpoint = parseCheckpoint(row.checkpoint);
      if (!checkpoint) continue;
      if (checkpoint.fase === "concluido") continue;
      if (checkpoint.tentativas_retomada >= nomusMaxRetomadas()) continue; // aguarda manual.
      return await resumeNomus(service, row, checkpoint);
    }
    if (fonte.tipo === "effecti") {
      const checkpoint = parseEffectiCheckpoint(row.checkpoint);
      if (!checkpoint) continue;
      if (checkpoint.fase === "concluido") continue;
      if (checkpoint.tentativas_retomada >= effectiMaxRetomadas()) continue; // aguarda manual.
      return await resumeEffecti(service, row, checkpoint);
    }
  }

  // 3. Inicia uma nova coleta se a fonte estiver DUE pela sua frequencia.
  if (await isFonteDue(service, fonte.id, frequencia)) {
    return await startFonte(service, fonte);
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

    const ocioso: OrquestrarResponse = {
      acao: "ocioso",
      execucao_id: null,
      fonte: null,
      recurso: null,
    };

    // O job pg_cron coleta-<tipo> manda { "fonte": "<tipo>" }. Sem fonte no
    // corpo (chamada legada/manual sem escopo) => nada a fazer.
    const tipo = await parseFonteBody(req);
    if (!tipo) return jsonResponse(ocioso, 200);

    // Fonte inexistente => ocioso (idempotente; cron escreve o tipo certo).
    const fonte = await loadFonteByTipo(service, tipo);
    if (!fonte) return jsonResponse(ocioso, 200);

    // Agendamento DESTA fonte desligado no painel => ocioso (sem criar exec).
    const agendamento = await loadAgendamentoFonte(service, fonte.id);
    if (!agendamento.ativo) {
      return jsonResponse({ ...ocioso, fonte: fonte.tipo }, 200);
    }

    const body = await tickFonte(service, fonte, agendamento.frequencia);

    // Auto-encadeamento (11/06): a coleta roda UM bloco por invocacao. Quando
    // ainda ha blocos (acao iniciou/avancou), reenfileira o orquestrador para o
    // proximo bloco via pg_net, fechando a janela inteira num so disparo do
    // agendamento. Em concluiu/ocioso a cadeia para. Best-effort: falha no
    // reenfileiramento nao derruba a resposta (o cron diario retoma).
    if (body.acao === "iniciou" || body.acao === "avancou") {
      const { error: reqError } = await service.rpc("reenfileirar_coleta", {
        p_fonte_tipo: fonte.tipo,
      });
      if (reqError) {
        console.error("reenfileirar_coleta falhou", reqError.message);
      }
    }

    return jsonResponse(body, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "ingestao-orquestrar" });
  }
}

getEnv();

Deno.serve(handler);
