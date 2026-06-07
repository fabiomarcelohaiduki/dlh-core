// =====================================================================
// Edge Function: ingestao-coletar  ->  POST /ingestao/coletar
// Cria a execucao e dispara o pipeline assincrono (US-02/04/05).
//
//   - Effecti (fonte padrao): recebe { fonte:'effecti', janelaDias? }, cria
//     execucao 'em_andamento' e roda o pipeline completo em background,
//     retornando { execucaoId, status:'em_andamento' } imediatamente.
//   - Nomus (multi-recurso): recebe { fonte:'nomus', recurso?:'processos' },
//     cria execucao com checkpoint, retorna 202 { execucao_id, estado } e
//     processa UM BLOCO de paginas em background (RF-20). O orquestrador
//     avanca os blocos seguintes nos tiques do ciclo.
//   - Anti-duplo-disparo GLOBAL (single-flight): recusa novo disparo enquanto
//     houver execucao 'em_andamento' -> 409 (US-04). No Nomus o 409 referencia
//     a execucao corrente ({ ja_em_andamento:true }).
//
// Toda escrita usa service_role server-side (SEC-05). Credencial lida do Vault
// em runtime, nunca de .env/cliente. Acao auditada.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  type ColetarInput,
  type ColetarRecurso,
  coletarSchema,
  type Gatilho,
  parseJsonBody,
} from "../_shared/validation.ts";
import { getFonteByTipo, getFonteSecret } from "../_shared/vault.ts";
import { createConnector } from "../_shared/effecti-connector.ts";
import { type NomusConnector, type NomusRecursoConfig } from "../_shared/nomus-connector.ts";
import { createEmbeddingProvider } from "../_shared/embeddings.ts";
import { createTextExtractor } from "../_shared/file-processing.ts";
import { runPipeline } from "../_shared/pipeline.ts";
import {
  buildInitialCheckpoint,
  type CheckpointModo,
  janelaMovel,
  runNomusBlock,
} from "../_shared/nomus-pipeline.ts";
import type { ColetaNomusResponse, ColetaResponse } from "../_shared/types.ts";

// EdgeRuntime expoe waitUntil para manter a funcao viva apos a resposta.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const DEFAULT_JANELA_DIAS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RECURSO: ColetarRecurso = "processos";

interface CallerContext {
  gatilho: Gatilho;
  usuario: string | null;
}

/**
 * Resolve o chamador: service_role (pg_cron / sistema -> 'agendada') ou
 * sessao humana autorizada (sob demanda -> 'manual'). O service_role e
 * identificado pela igualdade do Bearer com a chave de servico.
 */
async function resolveCaller(req: Request, requested?: Gatilho): Promise<CallerContext> {
  const token = extractBearerToken(req);
  const env = getEnv();

  if (token && token === env.serviceRoleKey) {
    return { gatilho: requested ?? "agendada", usuario: null };
  }

  const { email } = await requireAuthorizedUser(req);
  return { gatilho: "manual", usuario: email };
}

// ---------------------------------------------------------------------
// Effecti (fonte padrao) — fluxo de pipeline completo (inalterado)
// ---------------------------------------------------------------------

interface EffectiConfigRow {
  janela_dias: number | null;
  modalidades: string[] | null;
  portais: string[] | null;
}

async function loadEffectiConfig(
  service: ReturnType<typeof createServiceClient>,
  fonteId: string,
): Promise<EffectiConfigRow | null> {
  const { data, error } = await service
    .from("config_ingestao")
    .select("janela_dias, modalidades, portais")
    .eq("fonte_id", fonteId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar a config de ingestao");
  }
  return (data ?? null) as EffectiConfigRow | null;
}

async function handleEffecti(
  service: ReturnType<typeof createServiceClient>,
  input: ColetarInput,
  caller: CallerContext,
): Promise<Response> {
  const fonte = await getFonteByTipo("effecti");
  const token = await getFonteSecret(fonte.id);
  if (!token) {
    throw new HttpError(
      409,
      "credencial_nao_configurada",
      "credencial Effecti nao configurada: salve o token antes de coletar",
    );
  }

  const config = await loadEffectiConfig(service, fonte.id);
  const janelaDias = input.janelaDias ?? config?.janela_dias ?? DEFAULT_JANELA_DIAS;
  const sinceDate = new Date(Date.now() - janelaDias * MS_PER_DAY);
  const modalidades = config?.modalidades ?? undefined;
  const portais = config?.portais ?? undefined;

  const { data: execucao, error: insError } = await service
    .from("execucoes")
    .insert({
      inicio: new Date().toISOString(),
      gatilho: caller.gatilho,
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

  const connector = createConnector(fonte.tipo, {
    endpointBase: fonte.endpointBase,
    token,
  });
  const env = getEnv();
  const embeddingProvider = env.embeddingsEndpoint ? createEmbeddingProvider() : undefined;
  const textExtractor = env.fileExtractionEndpoint ? createTextExtractor() : undefined;

  const pipelinePromise = runPipeline(
    { db: service, connector, embeddingProvider, textExtractor },
    { execucaoId, sinceDate, modalidades, portais },
  ).catch((err) => {
    console.error("[ingestao-coletar] pipeline falhou", {
      execucaoId,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(pipelinePromise);
  }

  await logSensitiveAction({
    tabela: "execucoes",
    acao: "disparar_coleta",
    registroId: execucaoId,
    usuario: caller.usuario,
    dadosNovos: { gatilho: caller.gatilho, janelaDias, fonte: fonte.tipo },
  });

  const body: ColetaResponse = { execucaoId, status: "em_andamento" };
  return jsonResponse(body, 202);
}

// ---------------------------------------------------------------------
// Nomus (multi-recurso) — processamento em blocos com checkpoint
// ---------------------------------------------------------------------

interface NomusConfigRow {
  janela_dias: number | null;
  data_inicial: string | null;
  recursos: Record<string, unknown> | null;
}

async function loadNomusConfig(
  service: ReturnType<typeof createServiceClient>,
  fonteId: string,
): Promise<NomusConfigRow | null> {
  const { data, error } = await service
    .from("config_ingestao")
    .select("janela_dias, data_inicial, recursos")
    .eq("fonte_id", fonteId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar a config de ingestao");
  }
  return (data ?? null) as NomusConfigRow | null;
}

/** Le a config do recurso (recursos.<recurso>) com defaults seguros. */
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

async function handleNomus(
  service: ReturnType<typeof createServiceClient>,
  input: ColetarInput,
  caller: CallerContext,
): Promise<Response> {
  const recurso: ColetarRecurso = input.recurso ?? DEFAULT_RECURSO;

  // Fonte + credencial. Ausente -> 422 com mensagem generica por fonte (SEC-03).
  const fonte = await getFonteByTipo("nomus");
  const token = await getFonteSecret(fonte.id);
  if (!token) {
    throw new HttpError(
      422,
      "credencial_nao_configurada",
      "credencial da fonte nomus nao configurada: salve o token antes de coletar",
    );
  }

  // Single-flight GLOBAL: bloqueia se ja houver execucao em andamento (US-04).
  const { data: emAndamento, error: andamentoError } = await service
    .from("execucoes")
    .select("id, recurso")
    .eq("status", "em_andamento")
    .limit(1);
  if (andamentoError) {
    throw new HttpError(500, "execucao_query_failed", "falha ao verificar execucoes em andamento");
  }
  if (emAndamento && emAndamento.length > 0) {
    const corrente = emAndamento[0] as { id: string };
    const body: ColetaNomusResponse = {
      execucao_id: String(corrente.id),
      estado: "em_andamento",
      ja_em_andamento: true,
    };
    return jsonResponse(body, 409);
  }

  const config = await loadNomusConfig(service, fonte.id);
  const recursoConfig = readRecursoConfig(config?.recursos ?? null, recurso);
  const tiposAtivos = recursoConfig.tipos_ativos ?? [];

  // Janela: data_inicial (backfill) SOBREPOE janela_dias (incremental).
  const until = new Date();
  let since: Date;
  let modo: CheckpointModo;
  if (config?.data_inicial) {
    since = new Date(`${config.data_inicial}T00:00:00.000Z`);
    modo = "backfill";
  } else {
    const janelaDias = input.janelaDias ?? config?.janela_dias ?? DEFAULT_JANELA_DIAS;
    since = janelaMovel(janelaDias, until);
    modo = "incremental";
  }
  const janelaDias = input.janelaDias ?? config?.janela_dias ?? DEFAULT_JANELA_DIAS;
  const checkpoint = buildInitialCheckpoint(modo, since, until);

  const { data: execucao, error: insError } = await service
    .from("execucoes")
    .insert({
      inicio: new Date().toISOString(),
      gatilho: caller.gatilho,
      janela_dias: janelaDias,
      fonte_id: fonte.id,
      recurso,
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

  const connector = createConnector("nomus", {
    endpointBase: fonte.endpointBase,
    token,
    recurso,
    recursoConfig,
    janelaDias,
  }) as NomusConnector;
  const env = getEnv();
  const embeddingProvider = env.embeddingsEndpoint ? createEmbeddingProvider() : undefined;

  // Processa UM BLOCO em background; o orquestrador avanca os blocos seguintes.
  const blockPromise = runNomusBlock(
    { db: service, connector, embeddingProvider, fonteId: fonte.id },
    { execucaoId, recurso, tiposAtivos, checkpoint },
  ).catch((err) => {
    console.error("[ingestao-coletar] bloco nomus falhou", {
      execucaoId,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(blockPromise);
  }

  await logSensitiveAction({
    tabela: "execucoes",
    acao: "disparar_coleta",
    registroId: execucaoId,
    usuario: caller.usuario,
    dadosNovos: { gatilho: caller.gatilho, fonte: "nomus", recurso, modo, janelaDias },
  });

  const body: ColetaNomusResponse = { execucao_id: execucaoId, estado: "em_andamento" };
  return jsonResponse(body, 202);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    const input = await parseJsonBody(req, coletarSchema);
    const caller = await resolveCaller(req, input.gatilho);
    const service = createServiceClient();

    if (input.fonte === "nomus") {
      return await handleNomus(service, input, caller);
    }

    // Effecti (padrao): anti-duplo-disparo + pipeline completo.
    const { data: emAndamento, error: andamentoError } = await service
      .from("execucoes")
      .select("id")
      .eq("status", "em_andamento")
      .limit(1);
    if (andamentoError) {
      throw new HttpError(
        500,
        "execucao_query_failed",
        "falha ao verificar execucoes em andamento",
      );
    }
    if (emAndamento && emAndamento.length > 0) {
      throw new HttpError(
        409,
        "execucao_em_andamento",
        "ja existe uma coleta em andamento; aguarde a conclusao",
      );
    }

    return await handleEffecti(service, input, caller);
  } catch (err) {
    return await errorResponse(err, { fn: "ingestao-coletar" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
