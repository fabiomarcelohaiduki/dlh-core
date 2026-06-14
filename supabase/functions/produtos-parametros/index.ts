// =====================================================================
// Edge Function: produtos-parametros  (Dominio C - Parametros de calculo)
// CRUD/upsert dos parametros escalares (3 niveis: global/linha/produto), do
// vetor regional (5 regioes, override parcial) e a resolucao EFETIVA dos
// parametros de um Produto (PRODUTO -> LINHA -> GLOBAL, com origem). As
// escritas disparam o recalculo SINCRONO dos SKUs do escopo via triggers da
// sprint 2 (a borda apenas grava; o motor SQL recalcula).
//
// Rotas:
//   GET  /produtos-parametros/parametros?nivel=&escopo_id=     lista escalares
//   PUT  /produtos-parametros/parametros                       upsert escalar
//   GET  /produtos-parametros/parametros-regional?nivel=&escopo_id=  lista regional
//   PUT  /produtos-parametros/parametros-regional              upsert regional
//   GET  /produtos-parametros/parametros-resolvidos?produto_id=   efetivo+origem
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
import { isUuid, pickDefined, routeSegments } from "../_shared/rest.ts";
import {
  type ParametroNivel,
  parametroRegionalUpsertSchema,
  parametrosUpsertSchema,
  parseJsonBody,
  parseNivelFilter,
  type Regiao,
  REGIOES,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "produtos-parametros";

const PARAMETROS_COLUMNS =
  "id, nivel, escopo_id, impostos_pct, frete_pct, despesas_pct, lucro_pct, lucro_minimo_pct, taxa_horaria, horas_por_dia, created_at, updated_at";
const REGIONAL_COLUMNS = "id, nivel, escopo_id, regiao, percentual, created_at, updated_at";

/** Campos escalares dos parametros (ordem estavel para merge/log). */
const SCALAR_FIELDS = [
  "impostos_pct",
  "frete_pct",
  "despesas_pct",
  "lucro_pct",
  "lucro_minimo_pct",
  "taxa_horaria",
] as const;
type ScalarField = (typeof SCALAR_FIELDS)[number];

// horas_por_dia (jornada) e persistido no upsert mas resolvido SO no nivel
// global (constante da empresa) -> fora do SCALAR_FIELDS/endpoint resolvido.
const UPSERT_FIELDS = [...SCALAR_FIELDS, "horas_por_dia"] as const;

type ServiceClient = ReturnType<typeof createServiceClient>;

type Origem = ParametroNivel;

interface ScalarRow {
  impostos_pct: number | null;
  frete_pct: number | null;
  despesas_pct: number | null;
  lucro_pct: number | null;
  lucro_minimo_pct: number | null;
  taxa_horaria: number | null;
}

interface RegionalRow {
  regiao: Regiao;
  percentual: number | null;
}

/**
 * Aplica o filtro de escopo (escopo_id nulo no nivel global vira `is null`;
 * caso contrario `eq`). Centraliza a divergencia de PostgREST entre null e id.
 */
function applyEscopoFilter<T>(query: T, escopoId: string | null): T {
  // deno-lint-ignore no-explicit-any
  const q = query as any;
  return (escopoId === null ? q.is("escopo_id", null) : q.eq("escopo_id", escopoId)) as T;
}

// ---------------------------------------------------------------------
// /parametros  (escalares)
// ---------------------------------------------------------------------

async function listParametros(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nivel = parseNivelFilter(url.searchParams.get("nivel"));
  const escopoIdRaw = url.searchParams.get("escopo_id");
  if (escopoIdRaw !== null && escopoIdRaw.trim() !== "" && !isUuid(escopoIdRaw)) {
    throw new HttpError(400, "validation_error", "escopo_id deve ser UUID");
  }

  const db = createServiceClient();
  let query = db.from("parametros_calculo").select(PARAMETROS_COLUMNS);
  if (nivel) query = query.eq("nivel", nivel);
  if (escopoIdRaw && escopoIdRaw.trim() !== "") query = query.eq("escopo_id", escopoIdRaw);
  query = query.order("nivel", { ascending: true }).order("created_at", { ascending: true });

  const { data, error } = await query;
  if (error) {
    throw new HttpError(500, "parametros_query_failed", "falha ao listar parametros");
  }
  return jsonResponse({ items: data ?? [] }, 200);
}

async function upsertParametros(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, parametrosUpsertSchema);
  const escopoId = input.escopo_id ?? null;
  const db = createServiceClient();

  // Upsert com merge parcial: preserva campos nao informados (so grava os
  // presentes). Busca a linha atual por (nivel, escopo_id) e decide I/U.
  let selectExisting = db
    .from("parametros_calculo")
    .select("id")
    .eq("nivel", input.nivel);
  selectExisting = applyEscopoFilter(selectExisting, escopoId);
  const { data: existing, error: selectError } = await selectExisting.maybeSingle();
  if (selectError) {
    throw new HttpError(500, "parametros_query_failed", "falha ao consultar parametros");
  }

  const scalarPayload = pickDefined(input, UPSERT_FIELDS);

  let row: unknown;
  if (existing) {
    if (Object.keys(scalarPayload).length === 0) {
      throw new HttpError(400, "validation_error", "nenhum parametro informado para atualizar");
    }
    scalarPayload.updated_at = new Date().toISOString();
    const { data, error } = await db
      .from("parametros_calculo")
      .update(scalarPayload)
      .eq("id", existing.id)
      .select(PARAMETROS_COLUMNS)
      .single();
    if (error) {
      throw new HttpError(500, "parametros_update_failed", "falha ao atualizar parametros");
    }
    row = data;
  } else {
    const insertPayload = {
      nivel: input.nivel,
      escopo_id: escopoId,
      ...scalarPayload,
    };
    const { data, error } = await db
      .from("parametros_calculo")
      .insert(insertPayload)
      .select(PARAMETROS_COLUMNS)
      .single();
    if (error) {
      throw new HttpError(500, "parametros_insert_failed", "falha ao criar parametros");
    }
    row = data;
  }

  await logSensitiveAction({
    tabela: "parametros_calculo",
    acao: existing ? "atualizar" : "criar",
    registroId: (row as { id: string }).id,
    usuario: email,
    dadosNovos: { nivel: input.nivel, escopo_id: escopoId, ...scalarPayload },
  });

  return jsonResponse(row, 200);
}

// ---------------------------------------------------------------------
// /parametros-regional  (vetor regional)
// ---------------------------------------------------------------------

async function listRegional(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nivel = parseNivelFilter(url.searchParams.get("nivel"));
  const escopoIdRaw = url.searchParams.get("escopo_id");
  if (escopoIdRaw !== null && escopoIdRaw.trim() !== "" && !isUuid(escopoIdRaw)) {
    throw new HttpError(400, "validation_error", "escopo_id deve ser UUID");
  }

  const db = createServiceClient();
  let query = db.from("parametro_regional").select(REGIONAL_COLUMNS);
  if (nivel) query = query.eq("nivel", nivel);
  if (escopoIdRaw && escopoIdRaw.trim() !== "") query = query.eq("escopo_id", escopoIdRaw);
  query = query.order("regiao", { ascending: true });

  const { data, error } = await query;
  if (error) {
    throw new HttpError(500, "regional_query_failed", "falha ao listar vetor regional");
  }
  return jsonResponse({ items: data ?? [] }, 200);
}

async function upsertRegional(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, parametroRegionalUpsertSchema);
  const escopoId = input.escopo_id ?? null;
  const db = createServiceClient();

  // Override PARCIAL: upserta apenas as regioes informadas, por
  // (nivel, escopo_id, regiao). Loop sequencial p/ cada trigger recalcular.
  for (const item of input.regioes) {
    let selectExisting = db
      .from("parametro_regional")
      .select("id")
      .eq("nivel", input.nivel)
      .eq("regiao", item.regiao);
    selectExisting = applyEscopoFilter(selectExisting, escopoId);
    const { data: existing, error: selectError } = await selectExisting.maybeSingle();
    if (selectError) {
      throw new HttpError(500, "regional_query_failed", "falha ao consultar vetor regional");
    }

    // percentual null = herdar do nivel acima: remove o override (a coluna e
    // NOT NULL, entao "herdar" = ausencia de linha; o motor resolve por
    // coalesce produto->linha->global). Sem linha existente, nada a fazer.
    if (item.percentual == null) {
      if (existing) {
        const { error } = await db
          .from("parametro_regional")
          .delete()
          .eq("id", existing.id);
        if (error) {
          throw new HttpError(500, "regional_delete_failed", "falha ao limpar vetor regional");
        }
      }
      continue;
    }

    if (existing) {
      const { error } = await db
        .from("parametro_regional")
        .update({ percentual: item.percentual, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) {
        throw new HttpError(500, "regional_update_failed", "falha ao atualizar vetor regional");
      }
    } else {
      const { error } = await db
        .from("parametro_regional")
        .insert({
          nivel: input.nivel,
          escopo_id: escopoId,
          regiao: item.regiao,
          percentual: item.percentual,
        });
      if (error) {
        throw new HttpError(500, "regional_insert_failed", "falha ao criar vetor regional");
      }
    }
  }

  await logSensitiveAction({
    tabela: "parametro_regional",
    acao: "upsert",
    usuario: email,
    dadosNovos: {
      nivel: input.nivel,
      escopo_id: escopoId,
      regioes: input.regioes,
    },
  });

  // Retorna o vetor regional completo (todas as regioes do escopo).
  let query = db
    .from("parametro_regional")
    .select(REGIONAL_COLUMNS)
    .eq("nivel", input.nivel);
  query = applyEscopoFilter(query, escopoId);
  query = query.order("regiao", { ascending: true });
  const { data, error } = await query;
  if (error) {
    throw new HttpError(500, "regional_query_failed", "falha ao reler o vetor regional");
  }

  return jsonResponse({ items: data ?? [] }, 200);
}

// ---------------------------------------------------------------------
// /parametros-resolvidos  (efetivo vs herdado)
// ---------------------------------------------------------------------

/** Resolve um escalar por PRODUTO -> LINHA -> GLOBAL (primeiro nao-nulo). */
function resolveScalar(
  field: ScalarField,
  produto: ScalarRow | null,
  linha: ScalarRow | null,
  global: ScalarRow | null,
): { valor: number | null; origem: Origem } {
  if (produto && produto[field] != null) return { valor: produto[field], origem: "produto" };
  if (linha && linha[field] != null) return { valor: linha[field], origem: "linha" };
  if (global && global[field] != null) return { valor: global[field], origem: "global" };
  return { valor: null, origem: "global" };
}

/** Resolve a regiao por PRODUTO -> LINHA -> GLOBAL (primeiro nao-nulo). */
function resolveRegiao(
  regiao: Regiao,
  produto: Map<Regiao, number | null>,
  linha: Map<Regiao, number | null>,
  global: Map<Regiao, number | null>,
): { percentual: number | null; origem: Origem } {
  const pv = produto.get(regiao);
  if (pv != null) return { percentual: pv, origem: "produto" };
  const lv = linha.get(regiao);
  if (lv != null) return { percentual: lv, origem: "linha" };
  const gv = global.get(regiao);
  if (gv != null) return { percentual: gv, origem: "global" };
  return { percentual: null, origem: "global" };
}

async function loadScalarRow(
  db: ServiceClient,
  nivel: ParametroNivel,
  escopoId: string | null,
): Promise<ScalarRow | null> {
  let query = db
    .from("parametros_calculo")
    .select("impostos_pct, frete_pct, despesas_pct, lucro_pct, lucro_minimo_pct, taxa_horaria")
    .eq("nivel", nivel);
  query = applyEscopoFilter(query, escopoId);
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new HttpError(500, "parametros_query_failed", "falha ao resolver parametros");
  }
  return (data as ScalarRow | null) ?? null;
}

async function loadRegionalMap(
  db: ServiceClient,
  nivel: ParametroNivel,
  escopoId: string | null,
): Promise<Map<Regiao, number | null>> {
  let query = db
    .from("parametro_regional")
    .select("regiao, percentual")
    .eq("nivel", nivel);
  query = applyEscopoFilter(query, escopoId);
  const { data, error } = await query;
  if (error) {
    throw new HttpError(500, "regional_query_failed", "falha ao resolver vetor regional");
  }
  const map = new Map<Regiao, number | null>();
  for (const row of (data as RegionalRow[] | null) ?? []) {
    map.set(row.regiao, row.percentual);
  }
  return map;
}

async function resolveParametros(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const produtoId = url.searchParams.get("produto_id");
  if (!isUuid(produtoId)) {
    throw new HttpError(400, "validation_error", "produto_id deve ser UUID");
  }

  const db = createServiceClient();

  // Produto define a linha; 404 quando inexistente.
  const { data: produto, error: produtoError } = await db
    .from("produtos")
    .select("id, linha_id")
    .eq("id", produtoId)
    .maybeSingle();
  if (produtoError) {
    throw new HttpError(500, "produto_query_failed", "falha ao consultar o produto");
  }
  if (!produto) {
    throw new HttpError(404, "nao_encontrado", "produto nao encontrado");
  }
  const linhaId = produto.linha_id as string;

  // Carrega os 3 niveis (escalar e regional) em paralelo.
  const [scalarProduto, scalarLinha, scalarGlobal, regProduto, regLinha, regGlobal] = await Promise
    .all([
      loadScalarRow(db, "produto", produtoId),
      loadScalarRow(db, "linha", linhaId),
      loadScalarRow(db, "global", null),
      loadRegionalMap(db, "produto", produtoId),
      loadRegionalMap(db, "linha", linhaId),
      loadRegionalMap(db, "global", null),
    ]);

  const escalares: Record<ScalarField, { valor: number | null; origem: Origem }> = {
    impostos_pct: resolveScalar("impostos_pct", scalarProduto, scalarLinha, scalarGlobal),
    frete_pct: resolveScalar("frete_pct", scalarProduto, scalarLinha, scalarGlobal),
    despesas_pct: resolveScalar("despesas_pct", scalarProduto, scalarLinha, scalarGlobal),
    lucro_pct: resolveScalar("lucro_pct", scalarProduto, scalarLinha, scalarGlobal),
    lucro_minimo_pct: resolveScalar("lucro_minimo_pct", scalarProduto, scalarLinha, scalarGlobal),
    taxa_horaria: resolveScalar("taxa_horaria", scalarProduto, scalarLinha, scalarGlobal),
  };

  const regional: Record<Regiao, { percentual: number | null; origem: Origem }> = {} as Record<
    Regiao,
    { percentual: number | null; origem: Origem }
  >;
  for (const regiao of REGIOES) {
    regional[regiao] = resolveRegiao(regiao, regProduto, regLinha, regGlobal);
  }

  return jsonResponse({ escalares, regional }, 200);
}

// ---------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "PUT"]);

    const { email } = await requireAuthorizedUser(req);

    const segments = routeSegments(req, FUNCTION_SEGMENT);
    const root = segments[0];
    if (segments.length > 1) {
      throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
    }

    if (root === "parametros") {
      if (req.method === "GET") return await listParametros(req);
      if (req.method === "PUT") return await upsertParametros(req, email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou PUT");
    }

    if (root === "parametros-regional") {
      if (req.method === "GET") return await listRegional(req);
      if (req.method === "PUT") return await upsertRegional(req, email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou PUT");
    }

    if (root === "parametros-resolvidos") {
      if (req.method === "GET") return await resolveParametros(req);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET");
    }

    throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
