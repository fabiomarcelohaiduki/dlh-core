// =====================================================================
// Edge Function: nomus-disparar  ->  POST /nomus-disparar
// Dispara MANUALMENTE a coleta do Nomus pelo card da fonte (cockpit).
//
// O Nomus coleta num runner Node do GitHub Actions (o Edge/Deno nao fecha o
// TLS legado do Nomus). Este endpoint aciona o workflow_dispatch sob demanda
// no modo escolhido:
//   - incremental: regime permanente (watermark por id).
//   - full: backfill historico completo.
//
// Exige sessao autorizada (requireAuthorizedUser) + audit. Valida o corpo zod
// { modo } (incremental|full); valor desconhecido -> 422 sem I/O. A chamada a
// GitHub API roda server-side via RPC disparar_workflow_nomus (le o
// GITHUB_DISPATCH_TOKEN do Vault). Responde 202 (aceito; o workflow roda async).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { nomusDispararSchema, parseJsonBody } from "../_shared/validation.ts";

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao primeiro (SEC-02); corpo validado por allowlist (SEC-03).
    const { email } = await requireAuthorizedUser(req);
    const { modo } = await parseJsonBody(req, nomusDispararSchema, { validationStatus: 422 });

    // Dispara o workflow via RPC (le GITHUB_DISPATCH_TOKEN do Vault server-side).
    const service = createServiceClient();
    const { data: requestId, error } = await service.rpc("disparar_workflow_nomus", {
      p_modo: modo,
    });
    if (error) {
      throw new HttpError(502, "nomus_dispatch_failed", "falha ao acionar o workflow do Nomus");
    }

    await logSensitiveAction({
      tabela: "fontes",
      acao: "disparar_coleta_nomus",
      registroId: null,
      usuario: email,
      dadosNovos: { fonte: "nomus", modo, requestId: requestId ?? null },
    });

    // 202 Accepted: o workflow_dispatch foi aceito; a coleta roda assincrona
    // no runner do GitHub Actions (visibilidade pelo painel/heartbeat).
    return jsonResponse({ ok: true, modo, requestId: requestId ?? null }, 202);
  } catch (err) {
    return await errorResponse(err, { fn: "nomus-disparar" });
  }
}

getEnv();

Deno.serve(handler);
