// =====================================================================
// Edge Function: relacionamentos-vizinhanca
//
// POST /functions/v1/relacionamentos-vizinhanca
//
// Retorna a vizinhanca (bidirecional) de um no do grafo de
// Relacionamentos ate uma profundidade configurada. A consulta e
// feita pela RPC SECURITY DEFINER `public.relacoes_vizinhanca`, que
// caminha em recursao CTE sobre `public.relacoes` filtrando
// status='confirmado' e deduplica por (tipo, id) preservando o
// caminho de menor profundidade.
//
// Comportamento (sprint "Edge Functions de Leitura (panorama e
// vizinhanca) com cache"):
//   * Recebe { tipo, id, profundidade? }. profundidade clampada em
//     [0, 5] pelo zod (default 2 quando ausente). RPC tambem clampa.
//   * Resolve label/icone/cor do no ancora e dos vizinhos pela config da org.
//   * NAO grava audit_log (rota de leitura).
//
// Resposta JSON:
//   { no_ancora: NoVisual, nos: (NoVisual & { profundidade, caminho })[] }
//
// Borda padrao:
//   handleCorsPreflight -> assertMethod POST (405 para outros) ->
//   requireAuthorizedUser (401/403) -> resolucao de org_id via
//   org_membership -> parseJsonBody zod -> RPC -> formatacao ->
//   jsonResponse.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";
import {
  parseJsonBody,
  type RelacionamentosVizinhancaPayload,
  relacionamentosVizinhancaPayloadSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-vizinhanca";

/** Profundidade default quando ausente no payload. */
const DEFAULT_PROFUNDIDADE = 2;

// ---------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------

/** Linha retornada pela RPC relacoes_vizinhanca. */
interface VizinhoRpcRow {
  tipo: string;
  id: string;
  profundidade: number;
  caminho: string[];
}

/** Linha de config_tipos_no (subset usado pela UI). */
interface TipoNoRow {
  tipo: string;
  label: string;
  icone: string;
  cor: string;
  ativo: boolean;
}

/** No visual serializado para a UI. */
interface NoVisual {
  tipo: string;
  id: string;
  label: string;
  icone: string;
  cor: string;
}

/** Vizinho visual serializado para a UI. */
interface VizinhoVisual extends NoVisual {
  profundidade: number;
  caminho: string[];
}

/** Resposta final da Edge. */
interface VizinhancaResponse {
  no_ancora: NoVisual;
  nos: VizinhoVisual[];
}

type ServiceClient = ReturnType<typeof createServiceClient>;

// ---------------------------------------------------------------------
// Resolucao de tipos (label/icone/cor) por (org_id, tipo).
// ---------------------------------------------------------------------
async function carregarTiposDaOrg(
  db: ServiceClient,
  orgId: string,
): Promise<TipoNoRow[]> {
  const { data, error } = await db
    .from("config_tipos_no")
    .select("tipo, label, icone, cor, ativo")
    .eq("org_id", orgId);
  if (error) {
    throw new HttpError(500, "tipos_query_failed", "falha ao consultar tipos de no da org");
  }
  return (data ?? []) as TipoNoRow[];
}

async function resolverTipos(
  db: ServiceClient,
  orgId: string,
): Promise<Map<string, TipoNoRow>> {
  const rows = await carregarTiposDaOrg(db, orgId);
  const mapa = new Map<string, TipoNoRow>();
  for (const row of rows) {
    mapa.set(row.tipo, row);
  }
  return mapa;
}

// ---------------------------------------------------------------------
// Resolucao visual (label/icone/cor) de UM no a partir do mapa de tipos.
// Quando o tipo nao esta cadastrado OU esta inativo, devolve placeholders
// estaveis para a UI nao quebrar.
// ---------------------------------------------------------------------
function resolverVisual(
  tipo: string,
  id: string,
  tiposMap: Map<string, TipoNoRow>,
): NoVisual {
  const t = tiposMap.get(tipo);
  if (t && t.ativo) {
    return { tipo, id, label: t.label, icone: t.icone, cor: t.cor };
  }
  return { tipo, id, label: tipo, icone: "circle", cor: "#a1a1aa" };
}

// ---------------------------------------------------------------------
// Fetcher: chama a RPC SECURITY DEFINER `public.relacoes_vizinhanca`
// e devolve SOMENTE as linhas (sem formatacao visual - feita fora do
// fetcher para manter o contrato simples).
// ---------------------------------------------------------------------
interface VizinhancaCrua {
  ancora: VizinhoRpcRow;
  vizinhos: VizinhoRpcRow[];
}

async function buscarVizinhancaCrua(
  db: ServiceClient,
  payload: RelacionamentosVizinhancaPayload,
): Promise<VizinhancaCrua> {
  const profundidade = payload.profundidade ?? DEFAULT_PROFUNDIDADE;

  // A RPC e TEXT-based; profundidade e clampada na propria RPC em [0,5]
  // e retorna no minimo 1 linha (a propria ancora com profundidade=0).
  const { data, error } = await db.rpc("relacoes_vizinhanca", {
    p_tipo: payload.tipo,
    p_id: payload.id,
    p_profundidade: profundidade,
  });
  if (error) {
    throw new HttpError(500, "vizinhanca_query_failed", "falha ao consultar vizinhanca do no");
  }
  const rows = (data ?? []) as VizinhoRpcRow[];
  if (rows.length === 0) {
    // Defesa: a RPC sempre devolve ao menos 1 linha (a ancora). Se vier
    // vazia, e anomalia - devolve 404 explicito para a UI nao iterar
    // indefinidamente sobre lista vazia.
    throw new HttpError(404, "nao_encontrado", "no nao encontrado na vizinhanca");
  }

  const ancora = rows[0];
  // Demais linhas: vizinhos reais (a primeira linha e a propria ancora).
  const vizinhos = rows.slice(1);
  return { ancora, vizinhos };
}

// ---------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();
    const orgId = await resolverOrgIdUsuario(db, ctx.user.id);

    const payload = await parseJsonBody(req, relacionamentosVizinhancaPayloadSchema);

    // 1) Resolucao visual dos tipos (compartilhada com panorama).
    const tiposMap = await resolverTipos(db, orgId);

    const crua = await buscarVizinhancaCrua(db, payload);
    const no_ancora = resolverVisual(crua.ancora.tipo, crua.ancora.id, tiposMap);
    const nos: VizinhoVisual[] = crua.vizinhos.map((v) => ({
      ...resolverVisual(v.tipo, v.id, tiposMap),
      profundidade: v.profundidade,
      caminho: v.caminho,
    }));
    const resposta: VizinhancaResponse = { no_ancora, nos };

    return jsonResponse(resposta, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
