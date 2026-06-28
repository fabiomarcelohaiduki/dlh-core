// =====================================================================
// Edge Function: coleta-log  ->  GET /coleta-log
// Carga inicial do console ao vivo da guia "Logs" do submodulo Coleta: devolve
// as ultimas N linhas de coleta_log. O STREAM em si chega pelo Supabase
// Realtime (canal do usuario); esta Edge so preenche o console na abertura.
//
// AUTORIZACAO: sessao do cockpit (requireAuthorizedUser). Acesso a tabela por
//   service_role (RLS sem acesso anon direto). verify_jwt LIGADO (default).
//
// Query:
//   limite  quantas linhas trazer (default 300, teto 1000)
//   origem  filtra por fonte (effecti|nomus|gmail|drive|tika|sistema); opcional
//
// As linhas voltam em ORDEM CRONOLOGICA (id asc) para o console renderizar de
// cima para baixo; a selecao das "ultimas N" e feita por id desc no banco.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";

const ORIGENS_VALIDAS = ["effecti", "nomus", "gmail", "drive", "tika", "sistema"] as const;
const LIMITE_DEFAULT = 300;
const LIMITE_MAX = 1000;

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");
    await requireAuthorizedUser(req);

    const url = new URL(req.url);
    const limiteRaw = Number(url.searchParams.get("limite"));
    const limite = Number.isFinite(limiteRaw) && limiteRaw > 0
      ? Math.min(Math.floor(limiteRaw), LIMITE_MAX)
      : LIMITE_DEFAULT;
    const origem = url.searchParams.get("origem")?.trim() ?? "";
    if (origem && !(ORIGENS_VALIDAS as readonly string[]).includes(origem)) {
      throw new HttpError(400, "origem_invalida", "origem desconhecida");
    }

    const service = createServiceClient();
    let query = service
      .from("coleta_log")
      .select("id, execucao_id, comando_id, origem, nivel, mensagem, criado_em")
      .order("id", { ascending: false })
      .limit(limite);
    if (origem) query = query.eq("origem", origem);

    const { data, error } = await query;
    if (error) {
      throw new HttpError(500, "coleta_log_list_failed", "falha ao listar o log de coleta");
    }

    // Reverte para ordem cronologica (id asc) para o console exibir top->bottom.
    const linhas = (data ?? []).slice().reverse();
    return jsonResponse({ linhas });
  } catch (err) {
    return await errorResponse(err, { fn: "coleta-log" });
  }
}

getEnv();

Deno.serve(handler);
