// =====================================================================
// Edge Function: relacionamentos-config  (Relacionamentos - config da feature)
//
// Sub-rotas:
//   GET    /relacionamentos-config            retorna config_relacionamentos
//                                             da org (cria com defaults se nao existe)
//   POST   /relacionamentos-config            upsert da config_relacionamentos
//                                             (cria a linha se nao existir)
//   PUT    /relacionamentos-config            atualiza parcial da
//                                             config_relacionamentos (escopado
//                                             pela org do operador)
//
//   GET    /relacionamentos-config/tipos      lista config_tipos_no da org
//   POST   /relacionamentos-config/tipos      cria tipo (validacao zod por
//                                             allowlist de 7 tipos)
//   PUT    /relacionamentos-config/tipos      atualiza por id OU tipo
//                                             (UPSERT por (org_id, tipo))
//                                             ^^ Esta edge usa PUT para
//                                             upsert e update (mesma rota;
//                                             usa `id` OU `tipo` como chave)
//   DELETE /relacionamentos-config/tipos      remove por id ou ?tipo=xxx
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
import { assertUuid, pickDefined, routeSegments } from "../_shared/rest.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";
import {
  configRelacionamentosUpdateSchema,
  configTipoNoCreateSchema,
  configTipoNoUpdateSchema,
  parseJsonBody,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-config";
const CONFIG_COLUMNS =
  "id, org_id, uso_minimo_promocao_alternativa, dois_caminhos_minimo, uso_minimo_promocao, cap_panorama, cap_vizinhanca, profundidade_max_lia, profundidade_default_panorama, versao, created_at, updated_at";
const TIPO_COLUMNS =
  "id, org_id, tipo, label, icone, cor, ordem, ativo, versao, created_at, updated_at";

type ServiceClient = ReturnType<typeof createServiceClient>;

// Defaults da SPEC 2.1.4 (espelham os defaults da migration de seed).
// Usados SOMENTE quando a org ainda nao tem linha em config_relacionamentos
// (criacao sob demanda via GET).
const DEFAULTS_CONFIG = {
  uso_minimo_promocao_alternativa: 10,
  dois_caminhos_minimo: 5,
  uso_minimo_promocao: 5,
  cap_panorama: null,
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
    "cap_panorama",
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
// Helpers de config_tipos_no
// ---------------------------------------------------------------------

/** GET /relacionamentos-config/tipos - lista da org. */
async function listTipos(orgId: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("config_tipos_no")
    .select(TIPO_COLUMNS)
    .eq("org_id", orgId)
    .order("ordem", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    throw new HttpError(500, "tipos_query_failed", "falha ao listar os tipos de no");
  }
  return jsonResponse({ items: data ?? [] }, 200);
}

/** POST /relacionamentos-config/tipos - cria. */
async function createTipo(
  req: Request,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, configTipoNoCreateSchema);
  const db = createServiceClient();

  const payload: Record<string, unknown> = {
    org_id: orgId,
    tipo: input.tipo,
    label: input.label,
    icone: input.icone,
    cor: input.cor,
    ordem: input.ordem ?? 0,
    ativo: input.ativo ?? true,
  };

  const { data, error } = await db
    .from("config_tipos_no")
    .insert(payload)
    .select(TIPO_COLUMNS)
    .single();
  if (error) {
    // 23505 -> UNIQUE (org_id, tipo) ja existe.
    if (error.code === "23505") {
      throw new HttpError(409, "tipo_duplicado", "ja existe um tipo com este tipo para esta org");
    }
    throw new HttpError(500, "tipos_insert_failed", "falha ao criar o tipo");
  }

  await logSensitiveAction({
    tabela: "config_tipos_no",
    acao: "relacionamentos_tipo_criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: {
      tipo: data.tipo,
      label: data.label,
      icone: data.icone,
      cor: data.cor,
      ordem: data.ordem,
      ativo: data.ativo,
    },
  });

  return jsonResponse(data, 201);
}

/**
 * PUT /relacionamentos-config/tipos - upsert/update.
 *
 * Body precisa carregar identificador (id OU tipo). Quando ambos presentes
 * e divergentes, `id` vence. O UPSERT e no sentido REST: a borda atualiza
 * a config_tipos_no da org com base no `tipo` (chave UNIQUE), substituindo
 * label/icone/cor/ordem/ativo. Detalhe: o PostgREST do Supabase nao expoe
 * `upsert` por padrao sem uma `ON CONFLICT` no banco - a tabela JA tem
 * UNIQUE (org_id, tipo), entao usamos insert/update via service_role.
 */
async function updateTipo(
  req: Request,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, configTipoNoUpdateSchema);
  const db = createServiceClient();

  // Resolve filtro (id OU tipo) - id tem prioridade.
  let query = db.from("config_tipos_no").select(TIPO_COLUMNS).eq("org_id", orgId);
  if (input.id !== undefined) {
    query = query.eq("id", input.id);
  } else if (input.tipo !== undefined) {
    query = query.eq("tipo", input.tipo);
  }

  const { data: previous, error: readError } = await query.maybeSingle();
  if (readError) {
    throw new HttpError(500, "tipos_query_failed", "falha ao consultar o tipo");
  }
  if (!previous) {
    throw new HttpError(404, "nao_encontrado", "tipo nao encontrado");
  }

  const payload = pickDefined(input, ["label", "icone", "cor", "ordem", "ativo", "tipo"]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }

  // UPDATE por id para garantir escopo de uma unica linha da org.
  const { data, error } = await db
    .from("config_tipos_no")
    .update(payload)
    .eq("id", previous.id)
    .eq("org_id", orgId)
    .select(TIPO_COLUMNS)
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      throw new HttpError(409, "tipo_duplicado", "ja existe outro tipo com este tipo para esta org");
    }
    throw new HttpError(500, "tipos_update_failed", "falha ao atualizar o tipo");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "tipo nao encontrado");
  }

  await logSensitiveAction({
    tabela: "config_tipos_no",
    acao: "relacionamentos_tipo_editar",
    registroId: data.id,
    usuario: email,
    dadosAnteriores: {
      tipo: previous.tipo,
      label: previous.label,
      icone: previous.icone,
      cor: previous.cor,
      ordem: previous.ordem,
      ativo: previous.ativo,
    },
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

/** DELETE /relacionamentos-config/tipos - remove por id OU ?tipo=. */
async function deleteTipo(
  req: Request,
  orgId: string,
  email: string,
): Promise<Response> {
  const url = new URL(req.url);
  const idRaw = url.searchParams.get("id");
  const tipoRaw = url.searchParams.get("tipo")?.trim() ?? null;
  const db = createServiceClient();

  // Captura a linha para auditoria antes da remocao.
  let query = db
    .from("config_tipos_no")
    .select("id, tipo, label, icone, cor, ordem, ativo")
    .eq("org_id", orgId);
  if (idRaw) {
    query = query.eq("id", idRaw);
  } else if (tipoRaw) {
    query = query.eq("tipo", tipoRaw);
  } else {
    throw new HttpError(400, "validation_error", "informe o id OU tipo como query param");
  }

  const { data: existing, error: readError } = await query.maybeSingle();
  if (readError) {
    throw new HttpError(500, "tipos_query_failed", "falha ao consultar o tipo");
  }
  if (!existing) {
    throw new HttpError(404, "nao_encontrado", "tipo nao encontrado");
  }
  assertUuid(existing.id, "tipo");

  const { error } = await db
    .from("config_tipos_no")
    .delete()
    .eq("id", existing.id)
    .eq("org_id", orgId);
  if (error) {
    throw new HttpError(500, "tipos_delete_failed", "falha ao remover o tipo");
  }

  await logSensitiveAction({
    tabela: "config_tipos_no",
    acao: "relacionamentos_tipo_excluir",
    registroId: existing.id,
    usuario: email,
    dadosAnteriores: {
      tipo: existing.tipo,
      label: existing.label,
      icone: existing.icone,
      cor: existing.cor,
      ordem: existing.ordem,
      ativo: existing.ativo,
    },
  });

  return jsonResponse({ ok: true, id: existing.id }, 200);
}

// ---------------------------------------------------------------------
// Roteamento.
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "POST", "PUT", "DELETE"]);

    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();
    const orgId = await resolverOrgIdUsuario(db, ctx.user.id);

    const segments = routeSegments(req, FUNCTION_SEGMENT);
    const firstSegment = segments[0];

    // sub-rota /tipos
    if (firstSegment === "tipos") {
      // /relacionamentos-config/tipos/<id> nao e usado; mantemos /tipos + ?
      if (req.method === "GET") return await listTipos(orgId);
      if (req.method === "POST") return await createTipo(req, orgId, ctx.email);
      if (req.method === "PUT") return await updateTipo(req, orgId, ctx.email);
      if (req.method === "DELETE") return await deleteTipo(req, orgId, ctx.email);
      throw new HttpError(405, "method_not_allowed", "use GET, POST, PUT ou DELETE");
    }

    // Rota principal: GET (lazy create) / POST (upsert) / PUT (parcial).
    if (firstSegment === undefined) {
      if (req.method === "GET") return await getOrCreateConfig(orgId, ctx.email);
      // POST e mantido como alias semantico de PUT (allowlist de UI que
      // prefere POST para criar; ja existe config -> vira update).
      if (req.method === "POST") return await updateConfig(req, orgId, ctx.email);
      if (req.method === "PUT") return await updateConfig(req, orgId, ctx.email);
      throw new HttpError(405, "method_not_allowed", "use GET, POST ou PUT");
    }

    // segmentos extras nao suportados.
    throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
