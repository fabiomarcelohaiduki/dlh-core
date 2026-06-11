// =====================================================================
// Edge Function: ingestao-healthcheck  ->  GET /ingestao/healthcheck
// Le vw_healthcheck e mapeia o status para o contrato do front (US-15).
//   operacional -> "Saudavel" | degradado -> "Atencao" | parado -> "Falha"
// Exige sessao autorizada (_shared/auth.ts). Sem sessao -> 401.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import type { HealthcheckResponse, StatusIngestao } from "../_shared/types.ts";

function mapStatus(raw: string | null): StatusIngestao {
  switch (raw) {
    case "operacional":
      return "Saudavel";
    case "degradado":
      return "Atencao";
    case "parado":
      return "Falha";
    default:
      // Sem dado de status -> conservadoramente tratamos como Falha.
      return "Falha";
  }
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");
    const { db } = await requireAuthorizedUser(req);

    const { data, error } = await db
      .from("vw_healthcheck")
      .select("status_ingestao, ultima_sync, total_avisos, itens_com_erro")
      .maybeSingle();

    if (error) {
      throw new HttpError(500, "healthcheck_query_failed", "falha ao consultar healthcheck");
    }

    // Total de processos Nomus: contado via service_role (server-side). A
    // contagem direta de nomus_processos pelo browser e fragil (RLS/grant da
    // role authenticated), entao centralizamos no healthcheck, ja autorizado.
    const service = createServiceClient();
    const { count: totalProcessos, error: procError } = await service
      .from("nomus_processos")
      .select("*", { count: "exact", head: true });
    if (procError) {
      throw new HttpError(500, "healthcheck_query_failed", "falha ao contar processos");
    }

    const { count: totalPessoas, error: pessoaError } = await service
      .from("nomus_pessoas")
      .select("*", { count: "exact", head: true });
    if (pessoaError) {
      throw new HttpError(500, "healthcheck_query_failed", "falha ao contar pessoas");
    }

    const body: HealthcheckResponse = {
      statusIngestao: mapStatus((data?.status_ingestao as string | null) ?? null),
      ultimaSync: (data?.ultima_sync as string | null) ?? null,
      totalAvisos: Number(data?.total_avisos ?? 0),
      totalProcessos: Number(totalProcessos ?? 0),
      totalPessoas: Number(totalPessoas ?? 0),
      itensComErro: Number(data?.itens_com_erro ?? 0),
    };
    return jsonResponse(body, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "ingestao-healthcheck" });
  }
}

getEnv();

Deno.serve(handler);
