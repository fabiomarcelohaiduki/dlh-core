// =====================================================================
// Edge Function: relacionamentos-config  (Relacionamentos - config da feature)
//
// Rotas:
//   GET /relacionamentos-config     retorna config_relacionamentos da org
//                                   (cria com defaults se nao existe)
//   POST /relacionamentos-config    alias de PUT (UI que prefere POST)
//   PUT /relacionamentos-config     atualizacao parcial da
//                                   config_relacionamentos (escopada pela
//                                   org do operador)
//
// A gestao dos tipos de no (config_tipos_no) mora na Edge dedicada
// `relacionamentos-tipos-no` (tipos + tabela_fonte + campos reais).
//
// Borda padrao: handleCorsPreflight -> assertMethod -> requireAuthorizedUser
// (401/403) -> resolucao de org_id via org_membership -> validacao zod ->
// roteamento. Toda mutacao gera audit_log via logSensitiveAction.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { pickDefined, routeSegments } from "../_shared/rest.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";
import {
  configRelacionamentosUpdateSchema,
  parseJsonBody,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-config";
const CONFIG_COLUMNS =
  "id, org_id, uso_minimo_promocao_alternativa, dois_caminhos_minimo, uso_minimo_promocao, cap_vizinhanca, profundidade_max_lia, profundidade_default_panorama, versao, created_at, updated_at";

type ServiceClient = ReturnType<typeof createServiceClient>;

// Defaults da SPEC 2.1.4 (espelham os defaults da migration de seed).
// Usados SOMENTE quando a org ainda nao tem linha em config_relacionamentos
// (criacao sob demanda via GET).
const DEFAULTS_CONFIG = {
  uso_minimo_promocao_alternativa: 10,
  dois_caminhos_minimo: 5,
  uso_minimo_promocao: 5,
  cap_vizinhanca: 5,
  profundidade_max_lia: 5,
  profundidade_default_panorama: 2,
} as const;

// ---------------------------------------------------------------------
// Helpers de config_relacionamentos
// ---------------------------------------------------------------------

/**
 * GET /relacionamentos-config.
 * Cria com defaults (seed aditivo) se a org ainda nao tem config e devolve
 * a linha criada para o cliente.
 */
async function getOrCreateConfig(
  orgId: string,
  email: string,
): Promise<Response> {
  const db = createServiceClient();

  const { data: existing, error: readError } = await db
    .from("config_relacionamentos")
    .select(CONFIG_COLUMNS)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readError) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar configuracao da org");
  }
  if (existing) {
    return jsonResponse(existing, 200);
  }

  // Ausente -> cria com defaults (criacao sob demanda). Idempotente via UNIQUE.
  const { data: created, error: createError } = await db
    .from("config_relacionamentos")
    .insert({ org_id: orgId, ...DEFAULTS_CONFIG })
    .select(CONFIG_COLUMNS)
    .single();
  if (createError || !created) {
    // 23505 race condition - outra request criou em paralelo. Releitura.
    if (createError?.code === "23505") {
      const { data: race, error: raceError } = await db
        .from("config_relacionamentos")
        .select(CONFIG_COLUMNS)
        .eq("org_id", orgId)
        .maybeSingle();
      if (raceError || !race) {
        throw new HttpError(500, "config_query_failed", "falha ao consultar configuracao apos conflito de unicidade");
      }
      return jsonResponse(race, 200);
    }
    throw new HttpError(500, "config_insert_failed", "falha ao criar configuracao da org");
  }

  await logSensitiveAction({
    tabela: "config_relacionamentos",
    acao: "relacionamentos_config_criar",
    registroId: created.id,
    usuario: email,
    dadosNovos: { ...DEFAULTS_CONFIG, criado_por_demanda: true },
  });

  return jsonResponse(created, 200);
}

/** PUT /relacionamentos-config - atualizacao parcial (escopada por org_id). */
async function updateConfig(
  req: Request,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, configRelacionamentosUpdateSchema);
  const db = createServiceClient();

  const { data: previous, error: readError } = await db
    .from("config_relacionamentos")
    .select(CONFIG_COLUMNS)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readError) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar configuracao da org");
  }

  // Cria config sob demanda (caso UI tente editar antes de ler) com defaults.
  if (!previous) {
    return await getOrCreateConfig(orgId, email)
      .then(async () => await applyConfigUpdate(db, orgId, input, email));
  }

  return await applyConfigUpdate(db, orgId, input, email, previous);
}

async function applyConfigUpdate(
  db: ServiceClient,
  orgId: string,
  input: ReturnType<typeof configRelacionamentosUpdateSchema.parse>,
  email: string,
  previous?: Record<string, unknown>,
): Promise<Response> {
  const payload = pickDefined(input, [
    "uso_minimo_promocao_alternativa",
    "dois_caminhos_minimo",
    "uso_minimo_promocao",
    "cap_vizinhanca",
    "profundidade_max_lia",
    "profundidade_default_panorama",
  ]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }

  const { data, error } = await db
    .from("config_relacionamentos")
    .update(payload)
    .eq("org_id", orgId)
    .select(CONFIG_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_update_failed", "falha ao atualizar configuracao da org");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "config nao encontrada para a org");
  }

  const dadosAnteriores: Record<string, unknown> = previous ?? {};
  for (const key of Object.keys(payload)) {
    dadosAnteriores[key] = previous ? previous[key] : null;
  }

  await logSensitiveAction({
    tabela: "config_relacionamentos",
    acao: "relacionamentos_config_editar",
    registroId: data.id,
    usuario: email,
    dadosAnteriores,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

// ---------------------------------------------------------------------
// Roteamento.
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "POST", "PUT"]);

    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();
    const orgId = await resolverOrgIdUsuario(db, ctx.user.id);

    const segments = routeSegments(req, FUNCTION_SEGMENT);
    const firstSegment = segments[0];

    // Rota principal: GET (lazy create) / POST (alias de PUT) / PUT (parcial).
    if (firstSegment === undefined) {
      if (req.method === "GET") return await getOrCreateConfig(orgId, ctx.email);
      // POST e mantido como alias semantico de PUT (allowlist de UI que
      // prefere POST para criar; ja existe config -> vira update).
      if (req.method === "POST") return await updateConfig(req, orgId, ctx.email);
      if (req.method === "PUT") return await updateConfig(req, orgId, ctx.email);
      throw new HttpError(405, "method_not_allowed", "use GET, POST ou PUT");
    }

    // segmentos extras nao suportados (a gestao de tipos de no mora na
    // Edge relacionamentos-tipos-no).
    throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
