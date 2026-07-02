// =====================================================================
// Edge Function: relacionamentos-vinculos-lia  (Relacionamentos - CRUD + /decidir)
//
// CRUD de vinculos_inferidos_lia (memoria operacional da Lia) com endpoint
// dedicado /decidir para aprovacao/rejeicao/edicao pelos operadores do cockpit.
//
// Rotas:
//   GET    /relacionamentos-vinculos-lia            lista com filtros
//                                                   (?status=&origem=&contador_uso_min=
//                                                    &contador_uso_max=&limit=&offset=)
//   GET    /relacionamentos-vinculos-lia/:id        1 vinculo
//   POST   /relacionamentos-vinculos-lia            cria
//   PUT    /relacionamentos-vinculos-lia/:id        atualiza
//   DELETE /relacionamentos-vinculos-lia/:id        remove
//   POST   /relacionamentos-vinculos-lia/decidir    aprovar / rejeitar / editar
//                                                   (acao dedicada do cockpit)
//
// /decidir:
//   acao='aprovar'  - cria catalogo_regras_vinculo (validacao zod anti
//                     numero_pregao), seta vinculo.status='ativo' e
//                     regra_macro_id=<novo id>.
//   acao='rejeitar' - seta vinculo.status='descartado'; motivo obrigatorio.
//   acao='editar'   - corrige descricao/sequencia; motivo obrigatorio.
//
// Validacao anti numero_pregao replica o trigger do banco para devolver 422
// (em vez de 500) ja na borda. Toda mutacao gera audit_log via
// logSensitiveAction.
//
// Borda padrao: handleCorsPreflight -> assertMethod -> requireAuthorizedUser
// (401/403) -> resolucao de org_id via org_membership -> validacao zod ->
// roteamento.
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
  catalogoRegraCreateSchema,
  parseJsonBody,
  parsePagination,
  REL_CAMPOS_NUMERO_PREGAO,
  REL_NUMERO_PREGAO_REFINADO_MSG,
  RELACIONAMENTOS_VINCULO_STATUS,
  vinculoLiaCreateSchema,
  vinculoLiaDecidirSchema,
  vinculoLiaUpdateSchema,
} from "../_shared/validation.ts";
import type { z } from "zod";

const FUNCTION_SEGMENT = "relacionamentos-vinculos-lia";
const VINCULO_COLUMNS =
  "id, org_id, descricao, contador_uso, contador_2caminhos, origem, motivo, regra_macro_id, status, versao, created_at, updated_at";

type ServiceClient = ReturnType<typeof createServiceClient>;

const NUMERO_PREGAO_BLOCKER_STATUS = 422;
const NUMERO_PREGAO_BLOCKER_CODE = "regra_proibida_numero_pregao";
const NUMERO_PREGAO_BLOCKER_MESSAGE = REL_NUMERO_PREGAO_REFINADO_MSG;

/**
 * Defesa redundante contra combinacao='simples' + campo_destino sendo o numero
 * do pregao sozinho (`payload_bruto.processo` real ou `numero_pregao` legado).
 */
function assertNumeroPregaoValido(
  combinacao: string | undefined,
  campo_destino: string | undefined,
): void {
  if (
    combinacao === "simples" &&
    campo_destino !== undefined &&
    (REL_CAMPOS_NUMERO_PREGAO as readonly string[]).includes(campo_destino)
  ) {
    throw new HttpError(
      NUMERO_PREGAO_BLOCKER_STATUS,
      NUMERO_PREGAO_BLOCKER_CODE,
      NUMERO_PREGAO_BLOCKER_MESSAGE,
    );
  }
}

/**
 * Filtros aceitos em GET (par validity basica; zod foge do escopo aqui).
 * - status: deve estar no allowlist RELACIONAMENTOS_VINCULO_STATUS
 * - origem: deve estar em ('lia', 'humano')
 * - contador_uso_min/max: inteiros >= 0
 */
function parseFiltrosBusca(url: URL): {
  status: string | null;
  origem: string | null;
  contadorUsoMin: number;
  contadorUsoMax: number | null;
} {
  const statusRaw = url.searchParams.get("status")?.trim() ?? null;
  const origemRaw = url.searchParams.get("origem")?.trim() ?? null;

  const status = statusRaw && (RELACIONAMENTOS_VINCULO_STATUS as readonly string[]).includes(statusRaw)
    ? statusRaw
    : null;
  const origem = origemRaw && (origemRaw === "lia" || origemRaw === "humano")
    ? origemRaw
    : null;

  const minRaw = url.searchParams.get("contador_uso_min");
  const maxRaw = url.searchParams.get("contador_uso_max");
  const contadorUsoMinRaw = minRaw === null ? 0 : Number(minRaw);
  const contadorUsoMaxRaw = maxRaw === null ? null : Number(maxRaw);
  const contadorUsoMin = Number.isFinite(contadorUsoMinRaw) && contadorUsoMinRaw >= 0
    ? Math.trunc(contadorUsoMinRaw)
    : 0;
  const contadorUsoMax = contadorUsoMaxRaw !== null &&
      Number.isFinite(contadorUsoMaxRaw) && contadorUsoMaxRaw >= 0
    ? Math.trunc(contadorUsoMaxRaw)
    : null;

  return { status, origem, contadorUsoMin, contadorUsoMax };
}

// ---------------------------------------------------------------------
// GET lista com filtros (escopada por org_id).
// ---------------------------------------------------------------------
async function listVinculos(req: Request, orgId: string): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  const { status, origem, contadorUsoMin, contadorUsoMax } = parseFiltrosBusca(url);

  let query = db
    .from("vinculos_inferidos_lia")
    .select(VINCULO_COLUMNS, { count: "exact" })
    .eq("org_id", orgId)
    .order("contador_uso", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (origem) query = query.eq("origem", origem);
  if (contadorUsoMin > 0) query = query.gte("contador_uso", contadorUsoMin);
  if (contadorUsoMax !== null) query = query.lte("contador_uso", contadorUsoMax);

  const { data, count, error } = await query;
  if (error) {
    throw new HttpError(500, "vinculos_lia_query_failed", "falha ao listar vinculos inferidos pela Lia");
  }
  return jsonResponse({ items: data ?? [], total: count ?? 0, limit, offset }, 200);
}

// ---------------------------------------------------------------------
// GET por id (escopada por org_id).
// ---------------------------------------------------------------------
async function getVinculo(id: string, orgId: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("vinculos_inferidos_lia")
    .select(VINCULO_COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "vinculos_lia_query_failed", "falha ao consultar o vinculo");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "vinculo nao encontrado");
  }
  return jsonResponse(data, 200);
}

// ---------------------------------------------------------------------
// POST: cria vinculo (operador humano ou seed da IA).
// ---------------------------------------------------------------------
async function createVinculo(
  req: Request,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, vinculoLiaCreateSchema);

  const db = createServiceClient();
  const payload: Record<string, unknown> = {
    org_id: orgId,
    descricao: input.descricao,
    origem: input.origem,
    contador_uso: input.contador_uso ?? 0,
    contador_2caminhos: input.contador_2caminhos ?? 0,
    regra_macro_id: input.regra_macro_id ?? null,
    motivo: input.motivo ?? null,
  };

  const { data, error } = await db
    .from("vinculos_inferidos_lia")
    .insert(payload)
    .select(VINCULO_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(500, "vinculos_lia_insert_failed", "falha ao criar o vinculo");
  }

  await logSensitiveAction({
    tabela: "vinculos_inferidos_lia",
    acao: "relacionamentos_vinculo_criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: {
      descricao: data.descricao,
      origem: data.origem,
      contador_uso: data.contador_uso,
      contador_2caminhos: data.contador_2caminhos,
      regra_macro_id: data.regra_macro_id,
      motivo: data.motivo,
    },
  });

  return jsonResponse(data, 201);
}

// ---------------------------------------------------------------------
// PUT por id (escopada por org_id).
// ---------------------------------------------------------------------
async function updateVinculo(
  req: Request,
  id: string,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, vinculoLiaUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["descricao", "contador_uso", "contador_2caminhos"]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  // motivo e sempre persistido (snapshot da edicao humana) - mesmo quando ha outros campos.
  if (input.motivo !== undefined) payload.motivo = input.motivo;

  const { data: previous, error: previousError } = await db
    .from("vinculos_inferidos_lia")
    .select(VINCULO_COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (previousError) {
    throw new HttpError(500, "vinculos_lia_query_failed", "falha ao consultar o vinculo");
  }
  if (!previous) {
    throw new HttpError(404, "nao_encontrado", "vinculo nao encontrado");
  }

  const { data, error } = await db
    .from("vinculos_inferidos_lia")
    .update(payload)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(VINCULO_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "vinculos_lia_update_failed", "falha ao atualizar o vinculo");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "vinculo nao encontrado");
  }

  await logSensitiveAction({
    tabela: "vinculos_inferidos_lia",
    acao: "relacionamentos_vinculo_editar",
    registroId: id,
    usuario: email,
    dadosAnteriores: {
      descricao: previous.descricao,
      contador_uso: previous.contador_uso,
      contador_2caminhos: previous.contador_2caminhos,
    },
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

// ---------------------------------------------------------------------
// DELETE por id (escopada por org_id).
// ---------------------------------------------------------------------
async function deleteVinculo(
  id: string,
  orgId: string,
  email: string,
): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("vinculos_inferidos_lia")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "vinculos_lia_delete_failed", "falha ao remover o vinculo");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "vinculo nao encontrado");
  }
  await logSensitiveAction({
    tabela: "vinculos_inferidos_lia",
    acao: "relacionamentos_vinculo_excluir",
    registroId: id,
    usuario: email,
  });
  return jsonResponse({ ok: true, id }, 200);
}

// ---------------------------------------------------------------------
// POST /decidir - aprovar / rejeitar / editar
//
// Estrategia:
//   - carregar vinculo por id+org (404 se nao existe)
//   - ramo por acao:
//       aprovar: derivar payload de regra humana (origem/destino/combinacao/sequencia
//                de `dados` do body + campo_destino/campo_origem default `id`),
//                inserir em catalogo_regras_vinculo (zod + assertNumeroPregao
//                re-aplicado para 422), setar vinculo.status='ativo' e
//                regra_macro_id=<novo id>.
//       rejeitar: setar vinculo.status='descartado' + motivo
//       editar:   setar descricao (do body ou do input) + motivo
//   - audit_log com acao especifica por decisao
// ---------------------------------------------------------------------
async function decidirVinculo(
  req: Request,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, vinculoLiaDecidirSchema);
  const db = createServiceClient();

  // Carrega vinculo (escopado por org_id).
  const { data: vinculo, error: vinculoError } = await db
    .from("vinculos_inferidos_lia")
    .select(VINCULO_COLUMNS)
    .eq("id", input.vinculo_id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (vinculoError) {
    throw new HttpError(500, "vinculos_lia_query_failed", "falha ao consultar o vinculo");
  }
  if (!vinculo) {
    throw new HttpError(404, "nao_encontrado", "vinculo nao encontrado");
  }

  if (input.acao === "aprovar") {
    // Re-valida o payload minimo via catalogoRegraCreateSchema para detectar
    // combinacao='simples'+campo_destino='numero_pregao' precocemente. Como
    // o endpoint /decidir nao exige campo_origem/campo_destino explícitos, os
    // herdamos do par (origem_tipo, destino_tipo) com default `id` (campo
    // comum a todas as tabelas). Este default e seguro: nao cai em
    // numero_pregao sozinho.
    const regraPayload = {
      origem_tipo: input.dados.origem_tipo,
      campo_origem: "id",
      destino_tipo: input.dados.destino_tipo,
      campo_destino: "id",
      combinacao: input.dados.combinacao,
      sequencia: input.dados.sequencia,
    };
    const parsed = catalogoRegraCreateSchema.parse(regraPayload) as z.infer<
      typeof catalogoRegraCreateSchema
    >;
    assertNumeroPregaoValido(parsed.combinacao, parsed.campo_destino);

    // Insere regra humana.
    const { data: regra, error: regraErr } = await db
      .from("catalogo_regras_vinculo")
      .insert({
        org_id: orgId,
        nome: input.dados.nome ?? null,
        origem_tipo: parsed.origem_tipo,
        campo_origem: parsed.campo_origem,
        destino_tipo: parsed.destino_tipo,
        campo_destino: parsed.campo_destino,
        combinacao: parsed.combinacao,
        sequencia: parsed.sequencia ?? null,
        ativa: false,
      })
      .select("id")
      .single();
    if (regraErr) {
      if (regraErr.code === "23505") {
        throw new HttpError(409, "catalogo_regra_duplicada", "ja existe uma regra com essa assinatura");
      }
      throw new HttpError(500, "catalogo_regras_insert_failed", "falha ao criar a regra humana ao aprovar o vinculo");
    }

    // Atualiza vinculo: status='ativo' + regra_macro_id.
    const { data: updated, error: updateErr } = await db
      .from("vinculos_inferidos_lia")
      .update({
        status: "ativo",
        regra_macro_id: regra.id,
        motivo: input.motivo ?? vinculo.motivo ?? null,
      })
      .eq("id", input.vinculo_id)
      .eq("org_id", orgId)
      .select(VINCULO_COLUMNS)
      .maybeSingle();
    if (updateErr) {
      throw new HttpError(500, "vinculos_lia_update_failed", "falha ao ativar o vinculo");
    }
    if (!updated) {
      throw new HttpError(404, "nao_encontrado", "vinculo nao encontrado");
    }

    await logSensitiveAction({
      tabela: "vinculos_inferidos_lia",
      acao: "relacionamentos_vinculo_aprovar",
      registroId: input.vinculo_id,
      usuario: email,
      dadosAnteriores: { status: vinculo.status, regra_macro_id: vinculo.regra_macro_id },
      dadosNovos: {
        status: updated.status,
        regra_macro_id: updated.regra_macro_id,
        regra_humana_id: regra.id,
        motivo: input.motivo ?? null,
      },
    });
    // Tambem audita a regra humana criada (criada sem ativacao - exige
    // ativacao separada para virar regra "quente" no backfill).
    await logSensitiveAction({
      tabela: "catalogo_regras_vinculo",
      acao: "relacionamentos_regra_criar",
      registroId: regra.id,
      usuario: email,
      dadosNovos: {
        origem_tipo: parsed.origem_tipo,
        campo_origem: parsed.campo_origem,
        destino_tipo: parsed.destino_tipo,
        campo_destino: parsed.campo_destino,
        combinacao: parsed.combinacao,
        sequencia: parsed.sequencia ?? null,
        ativa: false,
        origem_criacao: "vinculo_aprovado",
      },
    });

    return jsonResponse({
      ok: true,
      vinculo_id: updated.id,
      status: updated.status,
      regra_id: regra.id,
    }, 200);
  }

  if (input.acao === "rejeitar") {
    // motivo ja validado pelo refine (obrigatorio quando acao != 'aprovar').
    const { data, error } = await db
      .from("vinculos_inferidos_lia")
      .update({
        status: "descartado",
        motivo: input.motivo,
      })
      .eq("id", input.vinculo_id)
      .eq("org_id", orgId)
      .select(VINCULO_COLUMNS)
      .maybeSingle();
    if (error) {
      throw new HttpError(500, "vinculos_lia_update_failed", "falha ao rejeitar o vinculo");
    }
    if (!data) {
      throw new HttpError(404, "nao_encontrado", "vinculo nao encontrado");
    }

    await logSensitiveAction({
      tabela: "vinculos_inferidos_lia",
      acao: "relacionamentos_vinculo_rejeitar",
      registroId: input.vinculo_id,
      usuario: email,
      dadosAnteriores: { status: vinculo.status, motivo: vinculo.motivo },
      dadosNovos: { status: data.status, motivo: input.motivo },
    });
    return jsonResponse({
      ok: true,
      vinculo_id: data.id,
      status: data.status,
    }, 200);
  }

  // acao === 'editar'
  if (!input.descricao || input.descricao.trim() === "") {
    throw new HttpError(
      422,
      "campo_obrigatorio",
      "acao 'editar' exige descricao no corpo da requisicao",
    );
  }
  const { data, error } = await db
    .from("vinculos_inferidos_lia")
    .update({
      descricao: input.descricao,
      motivo: input.motivo,
    })
    .eq("id", input.vinculo_id)
    .eq("org_id", orgId)
    .select(VINCULO_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "vinculos_lia_update_failed", "falha ao editar o vinculo");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "vinculo nao encontrado");
  }
  await logSensitiveAction({
    tabela: "vinculos_inferidos_lia",
    acao: "relacionamentos_vinculo_decidir_editar",
    registroId: input.vinculo_id,
    usuario: email,
    dadosAnteriores: { descricao: vinculo.descricao, motivo: vinculo.motivo },
    dadosNovos: { descricao: input.descricao, motivo: input.motivo ?? null },
  });
  return jsonResponse({
    ok: true,
    vinculo_id: data.id,
    status: data.status,
  }, 200);
}

// ---------------------------------------------------------------------
// Roteamento. /decidir e uma sub-rota anonima (rota dedicada).
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

    // /decidir e uma rota dedicada que captura ANTES do roteamento por id.
    if (firstSegment === "decidir") {
      if (req.method !== "POST") {
        throw new HttpError(405, "method_not_allowed", "use POST em /decidir");
      }
      return await decidirVinculo(req, orgId, ctx.email);
    }

    if (firstSegment === undefined) {
      if (req.method === "GET") return await listVinculos(req, orgId);
      if (req.method === "POST") return await createVinculo(req, orgId, ctx.email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
    }

    const id = assertUuid(firstSegment, "vinculo");
    if (req.method === "GET") return await getVinculo(id, orgId);
    if (req.method === "PUT") return await updateVinculo(req, id, orgId, ctx.email);
    if (req.method === "DELETE") return await deleteVinculo(id, orgId, ctx.email);
    throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET, PUT ou DELETE");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
