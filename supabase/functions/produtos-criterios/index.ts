// =====================================================================
// Edge Function: produtos-criterios  (Dominio E - cotacao/participacao)
// CRUD de cotacao_diretrizes, cotacao_regras e politica_participacao, com
// (re)indexacao/remocao dos textos indexaveis em memoria_chunks
// (origem='produto', tipo='produto-cotacao') reaproveitando o helper
// compartilhado de reindex (sprint 3): syncMemoriaChunks (delete-then-insert
// idempotente por origem+registro_id) e removeMemoriaChunks.
//
// Textos indexados:
//   - cotacao_diretrizes.texto         -> registro_id = cotacao_diretrizes.id
//   - politica_participacao.diretriz_texto -> registro_id = politica_participacao.id
// cotacao_regras NAO indexa (dados estruturados).
//
// Rotas:
//   GET    /produtos-criterios/cotacao-diretrizes?nivel=&escopo_id=   lista
//   POST   /produtos-criterios/cotacao-diretrizes                     cria (+reindex)
//   GET    /produtos-criterios/cotacao-diretrizes/:id                 detalhe
//   PUT    /produtos-criterios/cotacao-diretrizes/:id                 atualiza (+sync)
//   DELETE /produtos-criterios/cotacao-diretrizes/:id                 remove (+remove chunks)
//   GET    /produtos-criterios/cotacao-regras?nivel=&escopo_id=       lista
//   POST   /produtos-criterios/cotacao-regras                         cria
//   GET    /produtos-criterios/cotacao-regras/:id                     detalhe
//   PUT    /produtos-criterios/cotacao-regras/:id                     atualiza
//   DELETE /produtos-criterios/cotacao-regras/:id                     remove
//   GET    /produtos-criterios/politica-participacao?nivel=&escopo_id=  lista
//   POST   /produtos-criterios/politica-participacao                  cria (+reindex)
//   GET    /produtos-criterios/politica-participacao/:id              detalhe
//   PUT    /produtos-criterios/politica-participacao/:id              atualiza (+sync)
//   DELETE /produtos-criterios/politica-participacao/:id              remove (+remove chunks)
//
// Borda: handleCorsPreflight -> assertMethod -> requireAuthorizedUser ->
// validacao zod -> roteamento. Escrita server-side via service_role
// (autorizacao na borda; RLS deferida no schema de produtos).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { removeMemoriaChunks, syncMemoriaChunks } from "../_shared/memoria-reindex.ts";
import { assertUuid, deleteRowById, isUuid, pickDefined, routeSegments } from "../_shared/rest.ts";
import {
  cotacaoDiretrizCreateSchema,
  cotacaoDiretrizUpdateSchema,
  type CotacaoNivel,
  cotacaoRegraCreateSchema,
  cotacaoRegraUpdateSchema,
  parseCotacaoNivelFilter,
  parseJsonBody,
  parsePagination,
  politicaParticipacaoCreateSchema,
  politicaParticipacaoUpdateSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "produtos-criterios";

// Discriminadores fixos dos chunks de criterio no indice de memoria.
const CHUNK_ORIGEM = "produto";
const CHUNK_TIPO = "produto-cotacao";

const DIRETRIZ_COLUMNS = "id, nivel, escopo_id, texto, created_at, updated_at";
const REGRA_COLUMNS =
  "id, nivel, escopo_id, atributo, tipo_regra, valor_min, valor_max, substituicao, created_at, updated_at";
const POLITICA_COLUMNS =
  "id, nivel, escopo_id, participa, condicao, diretriz_texto, preferencia, created_at, updated_at";

// ---------------------------------------------------------------------
// Filtros de listagem (?nivel=&escopo_id=)
// ---------------------------------------------------------------------

interface CriterioFilter {
  nivel: CotacaoNivel | undefined;
  escopoId: string | null;
}

/** Resolve os filtros comuns de listagem; escopo_id presente e invalido -> 400. */
function parseCriterioFilter(url: URL): CriterioFilter {
  const nivel = parseCotacaoNivelFilter(url.searchParams.get("nivel"));
  const escopoIdRaw = url.searchParams.get("escopo_id");
  if (escopoIdRaw !== null && escopoIdRaw.trim() !== "" && !isUuid(escopoIdRaw)) {
    throw new HttpError(400, "validation_error", "escopo_id deve ser UUID");
  }
  const escopoId = escopoIdRaw !== null && escopoIdRaw.trim() !== "" ? escopoIdRaw : null;
  return { nivel, escopoId };
}

/**
 * Valida a coerencia de faixa (valor_min <= valor_max) ANTES do banco,
 * retornando 400 com mensagem especifica. Espelha cotacao_regras_faixa_check.
 */
function assertFaixaCoerente(
  valorMin: number | null | undefined,
  valorMax: number | null | undefined,
): void {
  if (valorMin != null && valorMax != null && valorMin > valorMax) {
    throw new HttpError(
      400,
      "faixa_invalida",
      "valor_min nao pode ser maior que valor_max",
    );
  }
}

// =====================================================================
// cotacao_diretrizes
// =====================================================================

async function listDiretrizes(req: Request): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  const { nivel, escopoId } = parseCriterioFilter(url);

  let query = db
    .from("cotacao_diretrizes")
    .select(DIRETRIZ_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (nivel) query = query.eq("nivel", nivel);
  if (escopoId) query = query.eq("escopo_id", escopoId);

  const { data, count, error } = await query;
  if (error) {
    throw new HttpError(500, "diretrizes_query_failed", "falha ao listar as diretrizes");
  }
  return jsonResponse({ items: data ?? [], total: count ?? 0, limit, offset }, 200);
}

async function getDiretriz(id: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("cotacao_diretrizes")
    .select(DIRETRIZ_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "diretriz_query_failed", "falha ao consultar a diretriz");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "diretriz nao encontrada");
  }
  return jsonResponse(data, 200);
}

async function createDiretriz(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, cotacaoDiretrizCreateSchema);
  const db = createServiceClient();

  const { data, error } = await db
    .from("cotacao_diretrizes")
    .insert({ nivel: input.nivel, escopo_id: input.escopo_id, texto: input.texto })
    .select(DIRETRIZ_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(500, "diretriz_insert_failed", "falha ao criar a diretriz");
  }

  // texto e NOT NULL e nao-vazio (zod min(1)) -> sempre reindexa.
  await syncMemoriaChunks(db, {
    origem: CHUNK_ORIGEM,
    tipo: CHUNK_TIPO,
    registroId: data.id,
    verbatim: input.texto,
  });

  await logSensitiveAction({
    tabela: "cotacao_diretrizes",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { nivel: input.nivel, escopo_id: input.escopo_id },
  });

  return jsonResponse(data, 201);
}

async function updateDiretriz(req: Request, id: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, cotacaoDiretrizUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["nivel", "escopo_id", "texto"]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("cotacao_diretrizes")
    .update(payload)
    .eq("id", id)
    .select(DIRETRIZ_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "diretriz_update_failed", "falha ao atualizar a diretriz");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "diretriz nao encontrada");
  }

  // Reindexa quando o texto foi tocado (sempre nao-vazio por zod min(1)).
  if (input.texto !== undefined) {
    await syncMemoriaChunks(db, {
      origem: CHUNK_ORIGEM,
      tipo: CHUNK_TIPO,
      registroId: id,
      verbatim: input.texto,
    });
  }

  await logSensitiveAction({
    tabela: "cotacao_diretrizes",
    acao: "atualizar",
    registroId: id,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deleteDiretriz(id: string, email: string): Promise<Response> {
  const db = createServiceClient();

  await deleteRowById(db, {
    table: "cotacao_diretrizes",
    id,
    recurso: "diretriz",
    errorCode: "diretriz_delete_failed",
  });

  // Remove os chunks indexados da diretriz (idempotente, mesma operacao).
  await removeMemoriaChunks(db, { origem: CHUNK_ORIGEM, registroId: id });

  await logSensitiveAction({
    tabela: "cotacao_diretrizes",
    acao: "remover",
    registroId: id,
    usuario: email,
  });

  return jsonResponse({ ok: true }, 200);
}

// =====================================================================
// cotacao_regras
// =====================================================================

async function listRegras(req: Request): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  const { nivel, escopoId } = parseCriterioFilter(url);

  let query = db
    .from("cotacao_regras")
    .select(REGRA_COLUMNS, { count: "exact" })
    .order("atributo", { ascending: true })
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (nivel) query = query.eq("nivel", nivel);
  if (escopoId) query = query.eq("escopo_id", escopoId);

  const { data, count, error } = await query;
  if (error) {
    throw new HttpError(500, "regras_query_failed", "falha ao listar as regras");
  }
  return jsonResponse({ items: data ?? [], total: count ?? 0, limit, offset }, 200);
}

async function getRegra(id: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("cotacao_regras")
    .select(REGRA_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "regra_query_failed", "falha ao consultar a regra");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "regra nao encontrada");
  }
  return jsonResponse(data, 200);
}

async function createRegra(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, cotacaoRegraCreateSchema);
  assertFaixaCoerente(input.valor_min, input.valor_max);
  const db = createServiceClient();

  const payload: Record<string, unknown> = {
    nivel: input.nivel,
    escopo_id: input.escopo_id,
    atributo: input.atributo,
    tipo_regra: input.tipo_regra,
    ...pickDefined(input, ["valor_min", "valor_max", "substituicao"]),
  };

  const { data, error } = await db
    .from("cotacao_regras")
    .insert(payload)
    .select(REGRA_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(500, "regra_insert_failed", "falha ao criar a regra");
  }

  await logSensitiveAction({
    tabela: "cotacao_regras",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { nivel: input.nivel, escopo_id: input.escopo_id, atributo: input.atributo },
  });

  return jsonResponse(data, 201);
}

async function updateRegra(req: Request, id: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, cotacaoRegraUpdateSchema);
  const db = createServiceClient();

  const { data: existing, error: existingError } = await db
    .from("cotacao_regras")
    .select("valor_min, valor_max")
    .eq("id", id)
    .maybeSingle();
  if (existingError) {
    throw new HttpError(500, "regra_query_failed", "falha ao consultar a regra");
  }
  if (!existing) {
    throw new HttpError(404, "nao_encontrado", "regra nao encontrada");
  }

  // Coerencia de faixa sobre os valores EFETIVOS (apos o merge parcial).
  const valorMinEff = input.valor_min !== undefined ? input.valor_min : existing.valor_min;
  const valorMaxEff = input.valor_max !== undefined ? input.valor_max : existing.valor_max;
  assertFaixaCoerente(valorMinEff, valorMaxEff);

  const payload = pickDefined(input, [
    "nivel",
    "escopo_id",
    "atributo",
    "tipo_regra",
    "valor_min",
    "valor_max",
    "substituicao",
  ]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("cotacao_regras")
    .update(payload)
    .eq("id", id)
    .select(REGRA_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(500, "regra_update_failed", "falha ao atualizar a regra");
  }

  await logSensitiveAction({
    tabela: "cotacao_regras",
    acao: "atualizar",
    registroId: id,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deleteRegra(id: string, email: string): Promise<Response> {
  const db = createServiceClient();

  await deleteRowById(db, {
    table: "cotacao_regras",
    id,
    recurso: "regra",
    errorCode: "regra_delete_failed",
  });

  await logSensitiveAction({
    tabela: "cotacao_regras",
    acao: "remover",
    registroId: id,
    usuario: email,
  });

  return jsonResponse({ ok: true }, 200);
}

// =====================================================================
// politica_participacao
// =====================================================================

async function listPolitica(req: Request): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  const { nivel, escopoId } = parseCriterioFilter(url);

  let query = db
    .from("politica_participacao")
    .select(POLITICA_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (nivel) query = query.eq("nivel", nivel);
  if (escopoId) query = query.eq("escopo_id", escopoId);

  const { data, count, error } = await query;
  if (error) {
    throw new HttpError(500, "politica_query_failed", "falha ao listar as politicas");
  }
  return jsonResponse({ items: data ?? [], total: count ?? 0, limit, offset }, 200);
}

async function getPolitica(id: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("politica_participacao")
    .select(POLITICA_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "politica_query_failed", "falha ao consultar a politica");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "politica nao encontrada");
  }
  return jsonResponse(data, 200);
}

async function createPolitica(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, politicaParticipacaoCreateSchema);
  const db = createServiceClient();

  const payload: Record<string, unknown> = {
    nivel: input.nivel,
    escopo_id: input.escopo_id,
    participa: input.participa,
    ...pickDefined(input, ["condicao", "diretriz_texto", "preferencia"]),
  };

  const { data, error } = await db
    .from("politica_participacao")
    .insert(payload)
    .select(POLITICA_COLUMNS)
    .single();
  if (error) {
    throw new HttpError(500, "politica_insert_failed", "falha ao criar a politica");
  }

  // Indexa diretriz_texto quando informada; vazia/null nao gera chunk (no-op).
  await syncMemoriaChunks(db, {
    origem: CHUNK_ORIGEM,
    tipo: CHUNK_TIPO,
    registroId: data.id,
    verbatim: input.diretriz_texto,
  });

  await logSensitiveAction({
    tabela: "politica_participacao",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { nivel: input.nivel, escopo_id: input.escopo_id, participa: input.participa },
  });

  return jsonResponse(data, 201);
}

async function updatePolitica(req: Request, id: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, politicaParticipacaoUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, [
    "nivel",
    "escopo_id",
    "participa",
    "condicao",
    "diretriz_texto",
    "preferencia",
  ]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("politica_participacao")
    .update(payload)
    .eq("id", id)
    .select(POLITICA_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "politica_update_failed", "falha ao atualizar a politica");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "politica nao encontrada");
  }

  // Sincroniza SOMENTE quando diretriz_texto foi tocada: nao-vazio reindexa;
  // vazio/null remove os chunks da politica.
  if (input.diretriz_texto !== undefined) {
    await syncMemoriaChunks(db, {
      origem: CHUNK_ORIGEM,
      tipo: CHUNK_TIPO,
      registroId: id,
      verbatim: input.diretriz_texto,
    });
  }

  await logSensitiveAction({
    tabela: "politica_participacao",
    acao: "atualizar",
    registroId: id,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deletePolitica(id: string, email: string): Promise<Response> {
  const db = createServiceClient();

  await deleteRowById(db, {
    table: "politica_participacao",
    id,
    recurso: "politica",
    errorCode: "politica_delete_failed",
  });

  // Remove os chunks indexados da politica (idempotente, mesma operacao).
  await removeMemoriaChunks(db, { origem: CHUNK_ORIGEM, registroId: id });

  await logSensitiveAction({
    tabela: "politica_participacao",
    acao: "remover",
    registroId: id,
    usuario: email,
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// Roteamento por recurso (colecao vs item)
// ---------------------------------------------------------------------

interface ResourceHandlers {
  list: (req: Request) => Promise<Response>;
  create: (req: Request, email: string) => Promise<Response>;
  get: (id: string) => Promise<Response>;
  update: (req: Request, id: string, email: string) => Promise<Response>;
  remove: (id: string, email: string) => Promise<Response>;
  recurso: string;
}

async function routeResource(
  req: Request,
  segments: string[],
  email: string,
  handlers: ResourceHandlers,
): Promise<Response> {
  const idRaw = segments[1];
  if (segments.length > 2) {
    throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
  }

  // Colecao: /<recurso>
  if (idRaw === undefined) {
    if (req.method === "GET") return await handlers.list(req);
    if (req.method === "POST") return await handlers.create(req, email);
    throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
  }

  // Item: /<recurso>/:id
  const id = assertUuid(idRaw, handlers.recurso);
  if (req.method === "GET") return await handlers.get(id);
  if (req.method === "PUT") return await handlers.update(req, id, email);
  if (req.method === "DELETE") return await handlers.remove(id, email);
  throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET, PUT ou DELETE");
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "POST", "PUT", "DELETE"]);

    // Autorizacao na borda (401 sem sessao, 403 fora da allowlist).
    const { email } = await requireAuthorizedUser(req);

    const segments = routeSegments(req, FUNCTION_SEGMENT);
    const root = segments[0];

    if (root === "cotacao-diretrizes") {
      return await routeResource(req, segments, email, {
        list: listDiretrizes,
        create: createDiretriz,
        get: getDiretriz,
        update: updateDiretriz,
        remove: deleteDiretriz,
        recurso: "diretriz",
      });
    }

    if (root === "cotacao-regras") {
      return await routeResource(req, segments, email, {
        list: listRegras,
        create: createRegra,
        get: getRegra,
        update: updateRegra,
        remove: deleteRegra,
        recurso: "regra",
      });
    }

    if (root === "politica-participacao") {
      return await routeResource(req, segments, email, {
        list: listPolitica,
        create: createPolitica,
        get: getPolitica,
        update: updatePolitica,
        remove: deletePolitica,
        recurso: "politica",
      });
    }

    throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
