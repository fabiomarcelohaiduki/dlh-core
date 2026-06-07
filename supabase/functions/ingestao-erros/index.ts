// =====================================================================
// Edge Function: ingestao-erros  ->  GET /ingestao/erros
// Lista erros_ingestao, filtrando por `etapa` (query param) quando informado.
// Ordenado por `quando` desc. Exige sessao autorizada. Sem sessao -> 401.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import type { Erro } from "../_shared/types.ts";

const MAX_ITEMS = 500;

interface ErroRow {
  id: string;
  execucao_id: string | null;
  aviso_id: string | null;
  severidade: string;
  etapa: string;
  mensagem: string;
  quando: string;
  status_reprocesso: string | null;
  origem: string | null;
  recurso: string | null;
  registro_id: string | null;
}

function toErro(row: ErroRow): Erro {
  return {
    id: row.id,
    execucaoId: row.execucao_id,
    avisoId: row.aviso_id,
    severidade: row.severidade,
    etapa: row.etapa,
    mensagem: row.mensagem,
    quando: row.quando,
    statusReprocesso: row.status_reprocesso,
    origem: row.origem ?? "aviso",
    recurso: row.recurso,
    registroId: row.registro_id,
  };
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");
    const etapa = new URL(req.url).searchParams.get("etapa")?.trim();
    const { db } = await requireAuthorizedUser(req);

    let query = db
      .from("erros_ingestao")
      .select(
        "id, execucao_id, aviso_id, severidade, etapa, mensagem, quando, status_reprocesso, origem, recurso, registro_id",
      )
      .order("quando", { ascending: false })
      .limit(MAX_ITEMS);

    if (etapa) {
      query = query.eq("etapa", etapa);
    }

    const { data, error } = await query;
    if (error) {
      throw new HttpError(500, "erros_query_failed", "falha ao listar erros de ingestao");
    }

    const items = ((data ?? []) as ErroRow[]).map(toErro);
    return jsonResponse({ items }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "ingestao-erros" });
  }
}

getEnv();

Deno.serve(handler);
