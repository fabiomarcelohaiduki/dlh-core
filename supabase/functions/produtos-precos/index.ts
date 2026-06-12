// =====================================================================
// Edge Function: produtos-precos  (Dominio C - Precos calculados)
// Leitura do grid de precos materializado (regiao x patamar) com estado e
// indicadores de apoio, escrita SOMENTE dos indicadores de apoio (nunca
// valor/custo_base, exclusivos do motor - RF-23), recalculo manual de
// fallback (chama EXATAMENTE fn_recalcular_sku, paridade com o caminho
// automatico) e listagem dos SKUs pendentes/erro.
//
// Rotas:
//   GET  /produtos-precos/skus/:skuId/precos          grid + estado + apoio
//   PUT  /produtos-precos/skus/:skuId/precos/apoio     grava so indicadores
//   POST /produtos-precos/skus/:skuId/recalcular       fallback manual
//   GET  /produtos-precos/precos/pendentes             SKUs pendente/erro
//
// Borda: handleCorsPreflight -> assertMethod -> requireAuthorizedUser ->
// validacao zod -> roteamento. Escrita server-side via service_role.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { assertUuid, pickDefined, routeSegments } from "../_shared/rest.ts";
import { parseJsonBody, precoApoioSchema } from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "produtos-precos";

const PRECOS_COLUMNS =
  "regiao, patamar, valor, estado, calculado_em, custo_base, ifp, preco_concorrencia, custo_ideal";

/**
 * Campos de apoio gravaveis pelo PUT. valor/custo_base/ifp NUNCA entram aqui:
 * sao exclusivos do motor (ifp varia por patamar/regiao, calculado em
 * fn_recalcular_sku) — RF-23.
 */
const APOIO_FIELDS = ["preco_concorrencia", "custo_ideal"] as const;

type ServiceClient = ReturnType<typeof createServiceClient>;

interface PrecoRow {
  regiao: string;
  patamar: string;
  valor: number | null;
  estado: string;
  calculado_em: string | null;
  custo_base: number | null;
  ifp: number | null;
  preco_concorrencia: number | null;
  custo_ideal: number | null;
}

/** Carrega o SKU (id + estado_calculo); 404 quando inexistente. */
async function loadSku(
  db: ServiceClient,
  skuId: string,
): Promise<{ id: string; estado_calculo: string }> {
  const { data, error } = await db
    .from("produto_skus")
    .select("id, estado_calculo")
    .eq("id", skuId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "sku_query_failed", "falha ao consultar o SKU");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "SKU nao encontrado");
  }
  return data as { id: string; estado_calculo: string };
}

/** Le as linhas do grid (regiao x patamar) de um SKU, ordenadas. */
async function loadPrecos(db: ServiceClient, skuId: string): Promise<PrecoRow[]> {
  const { data, error } = await db
    .from("sku_precos_calculados")
    .select(PRECOS_COLUMNS)
    .eq("sku_id", skuId)
    .order("regiao", { ascending: true })
    .order("patamar", { ascending: true });
  if (error) {
    throw new HttpError(500, "precos_query_failed", "falha ao consultar os precos");
  }
  return (data as PrecoRow[] | null) ?? [];
}

/** Monta o array de precos do grid (campos de exibicao do calculo). */
function toGrid(
  rows: PrecoRow[],
): Array<Pick<PrecoRow, "regiao" | "patamar" | "valor" | "ifp" | "estado" | "calculado_em">> {
  return rows.map((r) => ({
    regiao: r.regiao,
    patamar: r.patamar,
    valor: r.valor,
    ifp: r.ifp,
    estado: r.estado,
    calculado_em: r.calculado_em,
  }));
}

/** Extrai os indicadores de apoio (iguais em todas as linhas do SKU). */
function toApoio(
  rows: PrecoRow[],
): { preco_concorrencia: number | null; custo_ideal: number | null } {
  const first = rows[0];
  return {
    preco_concorrencia: first?.preco_concorrencia ?? null,
    custo_ideal: first?.custo_ideal ?? null,
  };
}

// ---------------------------------------------------------------------
// GET /skus/:skuId/precos
// ---------------------------------------------------------------------

async function getPrecos(skuId: string): Promise<Response> {
  const db = createServiceClient();
  const sku = await loadSku(db, skuId);
  const rows = await loadPrecos(db, skuId);

  return jsonResponse(
    {
      estado_calculo: sku.estado_calculo,
      precos: toGrid(rows),
      apoio: toApoio(rows),
      custo_base: rows[0]?.custo_base ?? null,
    },
    200,
  );
}

// ---------------------------------------------------------------------
// PUT /skus/:skuId/precos/apoio
// Grava SOMENTE ifp/preco_concorrencia/custo_ideal nas linhas do SKU; NUNCA
// toca valor/custo_base (exclusivos do motor - RF-23). null limpa o indicador.
// ---------------------------------------------------------------------

async function updateApoio(req: Request, skuId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, precoApoioSchema);
  const db = createServiceClient();
  await loadSku(db, skuId);

  // pickDefined preserva null (limpa) e descarta ausentes (preserva atual).
  const payload = pickDefined(input, APOIO_FIELDS);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum indicador de apoio informado");
  }
  payload.updated_at = new Date().toISOString();

  // Apoio e um conceito por SKU: replica nas 15 linhas (5 regioes x 3
  // patamares) para leitura consistente. NUNCA inclui valor/custo_base/ifp.
  const { error } = await db
    .from("sku_precos_calculados")
    .update(payload)
    .eq("sku_id", skuId);
  if (error) {
    throw new HttpError(500, "apoio_update_failed", "falha ao gravar indicadores de apoio");
  }

  await logSensitiveAction({
    tabela: "sku_precos_calculados",
    acao: "atualizar_apoio",
    registroId: skuId,
    usuario: email,
    dadosNovos: payload,
  });

  // Recarrega o apoio efetivo (linhas existentes); sem linhas -> echo do input.
  const rows = await loadPrecos(db, skuId);
  const apoio = rows.length > 0 ? toApoio(rows) : {
    preco_concorrencia: input.preco_concorrencia ?? null,
    custo_ideal: input.custo_ideal ?? null,
  };

  return jsonResponse({ apoio }, 200);
}

// ---------------------------------------------------------------------
// POST /skus/:skuId/recalcular
// Fallback manual: chama EXATAMENTE fn_recalcular_sku (paridade com o
// caminho automatico por trigger). Retorna o grid atualizado.
// ---------------------------------------------------------------------

async function recalcular(skuId: string, email: string): Promise<Response> {
  const db = createServiceClient();
  await loadSku(db, skuId);

  const { data: estado, error } = await db.rpc("fn_recalcular_sku", { p_sku_id: skuId });
  if (error) {
    throw new HttpError(500, "recalculo_failed", "falha ao recalcular o SKU");
  }

  await logSensitiveAction({
    tabela: "produto_skus",
    acao: "recalcular",
    registroId: skuId,
    usuario: email,
    dadosNovos: { estado_calculo: estado ?? null },
  });

  const rows = await loadPrecos(db, skuId);

  // estado_calculo: usa o retorno do motor; fallback p/ re-leitura do SKU.
  let estadoCalculo = estado as string | null;
  if (!estadoCalculo) {
    const sku = await loadSku(db, skuId);
    estadoCalculo = sku.estado_calculo;
  }

  return jsonResponse({ estado_calculo: estadoCalculo, precos: toGrid(rows) }, 200);
}

// ---------------------------------------------------------------------
// GET /precos/pendentes
// ---------------------------------------------------------------------

async function listPendentes(): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("produto_skus")
    .select("id, codigo_sku, estado_calculo")
    .in("estado_calculo", ["pendente", "erro"])
    .order("estado_calculo", { ascending: true })
    .order("codigo_sku", { ascending: true });
  if (error) {
    throw new HttpError(500, "pendentes_query_failed", "falha ao listar SKUs pendentes");
  }

  const items = (data ?? []).map((row) => ({
    sku_id: row.id as string,
    codigo_sku: row.codigo_sku as string,
    estado_calculo: row.estado_calculo as string,
  }));

  return jsonResponse({ items }, 200);
}

// ---------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "PUT", "POST"]);

    const { email } = await requireAuthorizedUser(req);

    const segments = routeSegments(req, FUNCTION_SEGMENT);
    const root = segments[0];

    // ----- /precos/pendentes -----
    if (root === "precos") {
      if (segments[1] === "pendentes" && segments.length === 2) {
        if (req.method === "GET") return await listPendentes();
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET");
      }
      throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
    }

    // ----- /skus/:skuId/{precos|precos/apoio|recalcular} -----
    if (root === "skus") {
      const skuId = assertUuid(segments[1], "SKU");
      const sub = segments[2];

      if (sub === "precos") {
        if (segments.length === 3) {
          if (req.method === "GET") return await getPrecos(skuId);
          throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET");
        }
        if (segments[3] === "apoio" && segments.length === 4) {
          if (req.method === "PUT") return await updateApoio(req, skuId, email);
          throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use PUT");
        }
        throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
      }

      if (sub === "recalcular" && segments.length === 3) {
        if (req.method === "POST") return await recalcular(skuId, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use POST");
      }

      throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
    }

    throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
