// =====================================================================
// Edge Function: relacionamentos-regras-semanticas  (Relacionamentos V2 - F4)
//
// CRUD das configuracoes de regras semanticas da org, em 2 BLOCOS:
//   * candidatos          -> vinculos_inferidos_lia AUDITAVEIS (revisao
//                            humana leve: ativar/desativar). Paginacao
//                            KEYSET (cursor opaco), SEM truncamento
//                            silencioso (E11).
//   * ajustes_tecnicos_lia -> config_relacionamentos (RENDER-ONLY, RNF-15).
//                            GET retorna; PATCH/POST/DELETE -> 403.
//
// Rotas:
//   GET    /relacionamentos-regras-semanticas         { candidatos, ajustes_tecnicos_lia }
//   POST   /relacionamentos-regras-semanticas         acao sobre um bloco
//   PATCH  /relacionamentos-regras-semanticas         acao sobre um bloco
//   DELETE /relacionamentos-regras-semanticas         acao sobre um bloco
//
// F5: o alias de transicao /relacionamentos-config foi removido. O path
// /relacionamentos-config e servido exclusivamente pela Edge dedicada
// `relacionamentos-config` (config_relacionamentos + config_tipos_no).
//
// Mapeamento de status (F5, gate S6 aplicado): a CHECK legada
// (proposta/ativa/rejeitada) foi removida e a CHECK superset (F4) e a unica
// guarda; as escritas usam o vocabulario NOVO. Semantica:
//   ativar    -> status='ativo'
//   desativar -> status='descartado'; motivo obrigatorio
//
// Borda padrao: handleCorsPreflight -> assertMethod -> requireAuthorizedUser
// (401/403) -> resolucao de org_id -> validacao zod -> roteamento. Mutacao de
// candidato auditada via logSensitiveAction.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";
import { parseJsonBody, relacionamentosRegraSemanticaAcaoSchema } from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-regras-semanticas";

const CANDIDATO_COLUMNS =
  "id, org_id, descricao, contador_uso, contador_2caminhos, origem, motivo, regra_macro_id, status, data_origem, contexto_origem, versao, created_at, updated_at";

const CONFIG_COLUMNS =
  "id, org_id, cap_por_grafo, clustering_threshold_nos, tipo_default_panorama, cap_vizinhanca, uso_minimo_promocao, uso_minimo_promocao_alternativa, dois_caminhos_minimo, profundidade_max_lia, profundidade_default_panorama, dry_run_limiares, versao, created_at, updated_at";

const DEFAULT_LIMITE = 25;
const MAX_LIMITE = 100;

// Defaults render-only quando a org ainda nao tem config_relacionamentos.
// Espelham os defaults das migrations (nao persistem aqui: bloco e read-only).
const CONFIG_DEFAULTS_RENDER = {
  cap_por_grafo: 200,
  clustering_threshold_nos: 80,
  tipo_default_panorama: "semantico",
  cap_vizinhanca: 5,
  uso_minimo_promocao: 5,
  uso_minimo_promocao_alternativa: 10,
  dois_caminhos_minimo: 5,
  profundidade_max_lia: 5,
  profundidade_default_panorama: 2,
  dry_run_limiares: {
    confianca_baixa: 0.5,
    cardinalidade_alta: 1000,
    duplicidade_pct: 0.2,
    amostra_insuficiente: 5,
  },
} as const;

// ---------------------------------------------------------------------
// Cursor opaco base64(JSON {c,k}): c=created_at ISO, k=id (tiebreaker).
// ---------------------------------------------------------------------
interface CursorKeyset {
  c: string;
  k: string;
}

function parseCursor(raw: string | null): CursorKeyset | null {
  if (raw === null || raw.trim() === "") return null;
  try {
    const decoded = JSON.parse(atob(raw)) as unknown;
    if (
      decoded && typeof decoded === "object" &&
      typeof (decoded as CursorKeyset).c === "string" &&
      typeof (decoded as CursorKeyset).k === "string"
    ) {
      return { c: (decoded as CursorKeyset).c, k: (decoded as CursorKeyset).k };
    }
    throw new Error("formato invalido");
  } catch {
    throw new HttpError(400, "invalid_cursor", "cursor invalido");
  }
}

function encodeCursor(keyset: CursorKeyset): string {
  return btoa(JSON.stringify(keyset));
}

function parseLimite(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_LIMITE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new HttpError(400, "invalid_limite", "limite deve ser um inteiro positivo");
  }
  return Math.min(n, MAX_LIMITE);
}

// ---------------------------------------------------------------------
// Bloco candidatos: keyset por (created_at desc, id desc).
// ---------------------------------------------------------------------
async function listCandidatos(
  orgId: string,
  cursor: CursorKeyset | null,
  limite: number,
): Promise<{ candidatos: unknown[]; nextCursor: string | null }> {
  const db = createServiceClient();

  let query = db
    .from("vinculos_inferidos_lia")
    .select(CANDIDATO_COLUMNS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limite + 1);

  if (cursor) {
    // (created_at, id) < (cursor.c, cursor.k) em ordem descendente.
    query = query.or(
      `created_at.lt.${cursor.c},and(created_at.eq.${cursor.c},id.lt.${cursor.k})`,
    );
  }

  const { data, error } = await query;
  if (error) {
    throw new HttpError(
      500,
      "candidatos_query_failed",
      "falha ao listar os candidatos de regras semanticas",
    );
  }

  const rows = (data ?? []) as Array<{ created_at: string; id: string }>;
  const hasMore = rows.length > limite;
  const items = hasMore ? rows.slice(0, limite) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ c: last.created_at, k: last.id }) : null;

  return { candidatos: items, nextCursor };
}

// ---------------------------------------------------------------------
// Bloco ajustes_tecnicos_lia (render-only): config_relacionamentos da org.
// ---------------------------------------------------------------------
async function readAjustesTecnicos(orgId: string): Promise<Record<string, unknown>> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("config_relacionamentos")
    .select(CONFIG_COLUMNS)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    throw new HttpError(
      500,
      "ajustes_tecnicos_query_failed",
      "falha ao consultar os ajustes tecnicos da Lia",
    );
  }

  const base = data ?? { org_id: orgId, ...CONFIG_DEFAULTS_RENDER };
  // Marca explicita: este bloco nunca e editavel por esta Edge (RNF-15).
  return { ...base, render_only: true };
}

// ---------------------------------------------------------------------
// GET: monta os 2 blocos.
// ---------------------------------------------------------------------
async function buildPayload(
  req: Request,
  orgId: string,
): Promise<Record<string, unknown>> {
  const url = new URL(req.url);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const limite = parseLimite(url.searchParams.get("limite"));

  const [{ candidatos, nextCursor }, ajustes] = await Promise.all([
    listCandidatos(orgId, cursor, limite),
    readAjustesTecnicos(orgId),
  ]);

  return {
    candidatos,
    nextCursor,
    limite,
    ajustes_tecnicos_lia: ajustes,
  };
}

// ---------------------------------------------------------------------
// Acao (POST/PATCH/DELETE): opera sobre um bloco.
//   ajustes_tecnicos -> 403 (render-only, RNF-15).
//   candidatos       -> ativar/desativar 1 vinculo inferido.
// ---------------------------------------------------------------------
async function handleAcao(
  req: Request,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, relacionamentosRegraSemanticaAcaoSchema);

  if (input.bloco === "ajustes_tecnicos") {
    throw new HttpError(
      403,
      "ajustes_tecnicos_render_only",
      "o bloco ajustes_tecnicos_lia e render-only e nao pode ser editado",
    );
  }

  // bloco === 'candidatos' (item_id garantido pelo schema).
  const itemId = input.item_id as string;
  const db = createServiceClient();

  const { data: previous, error: readError } = await db
    .from("vinculos_inferidos_lia")
    .select(CANDIDATO_COLUMNS)
    .eq("id", itemId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readError) {
    throw new HttpError(500, "candidato_query_failed", "falha ao consultar o candidato");
  }
  if (!previous) {
    throw new HttpError(404, "nao_encontrado", "candidato nao encontrado");
  }

  // Escrita no vocabulario NOVO (a CHECK legada foi removida no gate S6/F5).
  const novoStatus = input.operacao === "ativar" ? "ativo" : "descartado";
  const payload: Record<string, unknown> = { status: novoStatus };
  if (input.operacao === "desativar") {
    payload.motivo = input.motivo ?? null;
  }

  const { data, error } = await db
    .from("vinculos_inferidos_lia")
    .update(payload)
    .eq("id", itemId)
    .eq("org_id", orgId)
    .select(CANDIDATO_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "candidato_update_failed", "falha ao atualizar o candidato");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "candidato nao encontrado");
  }

  await logSensitiveAction({
    tabela: "vinculos_inferidos_lia",
    acao: input.operacao === "ativar"
      ? "relacionamentos_candidato_ativar"
      : "relacionamentos_candidato_desativar",
    registroId: itemId,
    usuario: email,
    dadosAnteriores: { status: previous.status, motivo: previous.motivo },
    dadosNovos: payload,
  });

  // Contrato SPEC §3.2.6: 200 retorna os 2 blocos (primeira pagina).
  const fresh = await buildPayload(req, orgId);
  return jsonResponse(fresh, 200);
}

// ---------------------------------------------------------------------
// Roteamento: segmentos apos FUNCTION_SEGMENT no path.
// ---------------------------------------------------------------------
function routeSegments(req: Request): string[] {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const idx = parts.indexOf(FUNCTION_SEGMENT);
  if (idx >= 0) return parts.slice(idx + 1);
  return parts;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "POST", "PATCH", "DELETE"]);

    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();
    const orgId = await resolverOrgIdUsuario(db, ctx.user.id);

    const segments = routeSegments(req);
    if (segments.length > 0) {
      throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
    }

    if (req.method === "GET") {
      return jsonResponse(await buildPayload(req, orgId), 200);
    }
    // POST/PATCH/DELETE: acao sobre um bloco.
    return await handleAcao(req, orgId, ctx.email);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
