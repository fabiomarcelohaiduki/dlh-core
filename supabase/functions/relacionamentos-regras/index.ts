// =====================================================================
// Edge Function: relacionamentos-regras  (Relacionamentos - CRUD do
// catalogo de regras macro humanas para casar nos por campo).
//
// Rotas:
//   GET    /relacionamentos-regras                lista (?ativa=&limit=&offset=) da org
//   GET    /relacionamentos-regras/:id            1 regra da org (404 se inexistente
//                                                ou de outra org)
//   POST   /relacionamentos-regras                cria (validacao zod anti
//                                                numero_pregao -> 422)
//   PUT    /relacionamentos-regras/:id            atualiza (mesma validacao)
//   DELETE /relacionamentos-regras/:id            remove (FK violation -> 409
//                                                quando ha vinculos
//                                                inferidos pendentes)
//
// Borda padrao:
//   handleCorsPreflight -> assertMethod -> requireAuthorizedUser (401/403)
//   -> resolucao de org_id via public.org_membership (select service_role)
//   -> validacao zod -> roteamento. Mutacoes auditadas via logSensitiveAction
//   com acoes distintas: criar / editar / ativar / excluir.
//
// Mensagens de erro em PT-BR. Validacao anti numero_pregao aplicada na borda
// (zod) e no banco (trigger tg_catalogo_regras_vinculo_anti_numero_pregao).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { assertUuid, isForeignKeyViolation, pickDefined, routeSegments } from "../_shared/rest.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";
import { podarArestasDaRegra } from "../_shared/relacionamentos-backfill.ts";
import {
  catalogoRegraCreateSchema,
  catalogoRegraUpdateSchema,
  parseBooleanFilter,
  parseJsonBody,
  parsePagination,
  REL_CAMPOS_NUMERO_PREGAO,
  REL_NUMERO_PREGAO_REFINADO_MSG,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-regras";
const REGRA_COLUMNS =
  "id, org_id, nome, origem_tipo, campo_origem, destino_tipo, campo_destino, combinacao, sequencia, modo_disparo, ativa, versao, created_at, updated_at";

/** Erro canonico de validacao para reproduzir a mensagem do trigger SQL. */
const NUMERO_PREGAO_BLOCKER_MESSAGE = REL_NUMERO_PREGAO_REFINADO_MSG;
const NUMERO_PREGAO_BLOCKER_STATUS = 422;
const NUMERO_PREGAO_BLOCKER_CODE = "regra_proibida_numero_pregao";

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Confere a regra do numero do pregao sozinho combinacao=simples. Replica o
 * trigger do banco para devolver 422 (em vez de 500) ja na borda. Cobre o campo
 * real `payload_bruto.processo` e o legado `numero_pregao`. `combinacao` ou
 * `campo_destino` ausentes sao ignorados (zod ja cuida).
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
 * Campos de matching que definem QUAIS arestas a regra gera. Se qualquer um
 * muda no PUT, as arestas antigas (chave `regra_macro:<id>`) ficam obsoletas e
 * precisam ser podadas antes do proximo backfill regravar as novas.
 */
const CAMPOS_MATCHING = [
  "origem_tipo",
  "campo_origem",
  "destino_tipo",
  "campo_destino",
  "combinacao",
  "sequencia",
] as const;

/**
 * Detecta se o patch altera algum campo de matching em relacao a regra atual.
 * `sequencia` (array|null) compara por JSON; os demais por igualdade direta.
 * Campos ausentes no patch (undefined) nao mudam nada.
 */
function matchMudou(
  previous: Record<string, unknown>,
  input: Record<string, unknown>,
): boolean {
  return CAMPOS_MATCHING.some((campo) => {
    const novo = input[campo];
    if (novo === undefined) return false;
    if (campo === "sequencia") {
      return JSON.stringify(novo ?? null) !== JSON.stringify(previous[campo] ?? null);
    }
    return novo !== previous[campo];
  });
}

function throwCatalogoRegraMutation(error: { code?: string }): never {
  if (error.code === "23505") {
    throw new HttpError(409, "catalogo_regra_duplicada", "ja existe uma regra com essa assinatura");
  }
  throw new HttpError(500, "catalogo_regras_mutation_failed", "falha ao salvar a regra");
}

// ---------------------------------------------------------------------
// GET lista (com filtro ?ativa= e paginacao).
// ---------------------------------------------------------------------
async function listRegras(req: Request, orgId: string): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  const ativa = parseBooleanFilter(url.searchParams.get("ativa"));

  let query = db
    .from("catalogo_regras_vinculo")
    .select(REGRA_COLUMNS, { count: "exact" })
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (ativa !== undefined) query = query.eq("ativa", ativa);

  const { data, count, error } = await query;
  if (error) {
    throw new HttpError(500, "catalogo_regras_query_failed", "falha ao listar o catalogo de regras");
  }
  return jsonResponse({ items: data ?? [], total: count ?? 0, limit, offset }, 200);
}

// ---------------------------------------------------------------------
// GET por id (escopado por org_id; 404 se de outra org).
// ---------------------------------------------------------------------
async function getRegra(id: string, orgId: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("catalogo_regras_vinculo")
    .select(REGRA_COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "catalogo_regras_query_failed", "falha ao consultar a regra");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "regra nao encontrada");
  }
  return jsonResponse(data, 200);
}

// ---------------------------------------------------------------------
// POST: cria regra (validacao zod anti numero_pregao -> 422).
// ---------------------------------------------------------------------
async function createRegra(
  req: Request,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, catalogoRegraCreateSchema);

  const db = createServiceClient();

  // Defesa redundante caso o schema tenha escapado: trigger do banco protege
  // mas queremos 422 (e nao 500) ja na borda.
  assertNumeroPregaoValido(input.combinacao, input.campo_destino);

  const payload: Record<string, unknown> = {
    org_id: orgId,
    nome: input.nome ?? null,
    origem_tipo: input.origem_tipo,
    campo_origem: input.campo_origem,
    destino_tipo: input.destino_tipo,
    campo_destino: input.campo_destino,
    combinacao: input.combinacao,
    sequencia: input.sequencia ?? null,
    modo_disparo: input.modo_disparo ?? "agendado",
    ativa: input.ativa ?? false,
  };

  const { data, error } = await db
    .from("catalogo_regras_vinculo")
    .insert(payload)
    .select(REGRA_COLUMNS)
    .single();

  if (error) {
    throwCatalogoRegraMutation(error);
  }

  // Acao de auditoria distingue criacao (ativa=false) vs ativacao separada.
  const ativaResult = data.ativa === true;
  await logSensitiveAction({
    tabela: "catalogo_regras_vinculo",
    acao: ativaResult ? "relacionamentos_regra_ativar" : "relacionamentos_regra_criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: {
      nome: data.nome,
      origem_tipo: data.origem_tipo,
      campo_origem: data.campo_origem,
      destino_tipo: data.destino_tipo,
      campo_destino: data.campo_destino,
      combinacao: data.combinacao,
      sequencia: data.sequencia,
      modo_disparo: data.modo_disparo,
      ativa: data.ativa,
    },
  });

  return jsonResponse(data, 201);
}

// ---------------------------------------------------------------------
// PUT: atualiza campos editaveis (mesma validacao zod anti numero_pregao).
// Distingue acao de auditoria conforme toggle `ativa`:
//   ativa false -> true   -> "relacionamentos_regra_ativar"
//   ativa true  -> false  -> "relacionamentos_regra_desativar"
//   outro patch           -> "relacionamentos_regra_editar"
// ---------------------------------------------------------------------
async function updateRegra(
  req: Request,
  id: string,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, catalogoRegraUpdateSchema);

  const db = createServiceClient();
  // Carrega regra antes do patch para checar escopo e calcular acao de auditoria.
  const { data: previous, error: previousError } = await db
    .from("catalogo_regras_vinculo")
    .select(REGRA_COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();

  if (previousError) {
    throw new HttpError(500, "catalogo_regras_query_failed", "falha ao consultar a regra");
  }
  if (!previous) {
    throw new HttpError(404, "nao_encontrado", "regra nao encontrada");
  }

  assertNumeroPregaoValido(
    input.combinacao ?? previous.combinacao,
    input.campo_destino ?? previous.campo_destino,
  );

  const payload = pickDefined(input, [
    "nome",
    "origem_tipo",
    "campo_origem",
    "destino_tipo",
    "campo_destino",
    "combinacao",
    "sequencia",
    "modo_disparo",
    "ativa",
  ]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }

  const { data, error } = await db
    .from("catalogo_regras_vinculo")
    .update(payload)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(REGRA_COLUMNS)
    .maybeSingle();

  if (error) {
    throwCatalogoRegraMutation(error);
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "regra nao encontrada");
  }

  const desativou = typeof input.ativa === "boolean" &&
    input.ativa === false && previous.ativa === true;

  let acao: string;
  if (typeof input.ativa === "boolean" && input.ativa !== previous.ativa) {
    acao = input.ativa
      ? "relacionamentos_regra_ativar"
      : "relacionamentos_regra_desativar";
  } else {
    acao = "relacionamentos_regra_editar";
  }

  // Poda das arestas obsoletas: desativar ou mudar os campos de matching torna
  // as arestas antigas (chave `regra_macro:<id>`) invalidas. Remove-as aqui;
  // a regeneracao (quando a regra segue/volta ativa) acontece no gate S7 de
  // ativacao, que recomputa o hash de frescor e roda a Fase 2 da regra.
  let arestasRemovidas = 0;
  if (desativou || matchMudou(previous, payload)) {
    arestasRemovidas = await podarArestasDaRegra(db, id);
  }

  await logSensitiveAction({
    tabela: "catalogo_regras_vinculo",
    acao,
    registroId: id,
    usuario: email,
    dadosAnteriores: {
      nome: previous.nome,
      origem_tipo: previous.origem_tipo,
      campo_origem: previous.campo_origem,
      destino_tipo: previous.destino_tipo,
      campo_destino: previous.campo_destino,
      combinacao: previous.combinacao,
      sequencia: previous.sequencia,
      modo_disparo: previous.modo_disparo,
      ativa: previous.ativa,
    },
    dadosNovos: { ...payload, arestas_removidas: arestasRemovidas },
  });

  return jsonResponse({ ...data, arestas_removidas: arestasRemovidas }, 200);
}

// ---------------------------------------------------------------------
// DELETE: remove regra por id (captura FK violation 23503 -> 409 quando ha
// vinculos_inferidos_lia pendentes referenciando esta regra).
// ---------------------------------------------------------------------
async function deleteRegra(
  id: string,
  orgId: string,
  email: string,
): Promise<Response> {
  const db = createServiceClient();

  const { data, error } = await db
    .from("catalogo_regras_vinculo")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id")
    .maybeSingle();

  if (error) {
    if (isForeignKeyViolation(error)) {
      throw new HttpError(
        409,
        "regra_em_uso",
        "regra possui vinculos inferidos pela Lia pendentes; remova ou rejeite os vinculos antes de excluir a regra",
      );
    }
    throw new HttpError(500, "catalogo_regras_delete_failed", "falha ao remover a regra");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "regra nao encontrada");
  }

  // Regra removida: as arestas que ela gerou (chave `regra_macro:<id>`) ficam
  // orfas. Poda-as agora (sem regeneracao - a regra deixou de existir).
  const arestasRemovidas = await podarArestasDaRegra(db, id);

  await logSensitiveAction({
    tabela: "catalogo_regras_vinculo",
    acao: "relacionamentos_regra_excluir",
    registroId: id,
    usuario: email,
    dadosNovos: { arestas_removidas: arestasRemovidas },
  });

  return jsonResponse({ ok: true, id, arestas_removidas: arestasRemovidas }, 200);
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
    const idRaw = segments[0];

    if (idRaw === undefined) {
      if (req.method === "GET") return await listRegras(req, orgId);
      if (req.method === "POST") return await createRegra(req, orgId, ctx.email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
    }

    const id = assertUuid(idRaw, "regra");
    if (req.method === "GET") return await getRegra(id, orgId);
    if (req.method === "PUT") return await updateRegra(req, id, orgId, ctx.email);
    if (req.method === "DELETE") return await deleteRegra(id, orgId, ctx.email);
    throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET, PUT ou DELETE");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
