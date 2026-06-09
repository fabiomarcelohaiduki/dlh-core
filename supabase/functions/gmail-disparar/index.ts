// =====================================================================
// Edge Function: gmail-disparar  ->  POST /gmail-disparar
// Dispara MANUALMENTE a coleta do Gmail pelo card da fonte (cockpit).
//
// O Gmail coleta num runner Node do GitHub Actions (a credencial Gmail e a API
// do Google so existem la). Este endpoint aciona o workflow extrair-anexos.yml
// com fonte='gmail': o runner monta a query pelo gmail-config (data_inicial +
// labels), descobre as mensagens e enfileira corpo + anexos na fila de
// documentos. O Drive NAO e varrido nesse disparo; a extracao (Tika) drena a
// fila inteira normalmente.
//
// Sem corpo (a janela de coleta vem da config administravel no cockpit). Exige
// sessao autorizada (requireAuthorizedUser) + audit. A chamada a GitHub API
// roda server-side via RPC disparar_workflow_gmail (le o GITHUB_DISPATCH_TOKEN
// do Vault). Responde 202 (aceito; o workflow roda async).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao primeiro (SEC-02). Sem corpo: a janela vem do gmail-config.
    const { email } = await requireAuthorizedUser(req);

    // Dispara o workflow via RPC (le GITHUB_DISPATCH_TOKEN do Vault server-side).
    const service = createServiceClient();
    const { data: requestId, error } = await service.rpc("disparar_workflow_gmail");
    if (error) {
      throw new HttpError(502, "gmail_dispatch_failed", "falha ao acionar a coleta do Gmail");
    }

    await logSensitiveAction({
      tabela: "fontes",
      acao: "disparar_coleta_gmail",
      registroId: null,
      usuario: email,
      dadosNovos: { fonte: "gmail", requestId: requestId ?? null },
    });

    // 202 Accepted: o workflow_dispatch foi aceito; a coleta roda assincrona
    // no runner do GitHub Actions (visibilidade pelo painel de Execucoes).
    return jsonResponse({ ok: true, requestId: requestId ?? null }, 202);
  } catch (err) {
    return await errorResponse(err, { fn: "gmail-disparar" });
  }
}

getEnv();

Deno.serve(handler);
