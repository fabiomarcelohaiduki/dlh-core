// =====================================================================
// Edge Function: drive-disparar  ->  POST /drive-disparar
// Dispara MANUALMENTE a COLETA/DESCOBERTA do Drive pelo card Drive (cockpit).
//
// A descoberta do Drive roda no runner Node do GitHub Actions (a lista de
// arquivos vive na API do Google e a credencial so existe la), no workflow
// PROPRIO coletar-drive.yml (independente da extracao — decisao 10/06: cada
// fonte coleta no seu workflow; o extrator virou drain puro). Por isso o botao
// "Coletar agora" do card Drive aciona este endpoint -> RPC
// disparar_workflow_drive (le o GITHUB_DISPATCH_TOKEN do Vault server-side).
//
// Sem corpo (as pastas Drive ativas vem do runner). Exige sessao autorizada
// (requireAuthorizedUser) + audit. Responde 202 (aceito; o workflow roda async).
//
// ANTI-DUPLO-DISPARO: a descoberta do Drive NAO grava linha em execucoes (so
// enfileira vinculos, nao registra coleta de origem), entao nao ha camada de
// banco. O concurrency group do proprio workflow ja serializa, e checamos a
// GitHub API por runs ativos do coletar-drive.yml para devolver um 409 limpo no
// clique rapido. Best-effort: qualquer falha (token/API) degrada para so o
// concurrency group do GitHub. Espelha a extracao-disparar.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { workflowRunsUrl } from "../_shared/github.ts";

const DRIVE_RUNS_URL = workflowRunsUrl("coletar-drive.yml");

/**
 * True quando ha um run do coletar-drive.yml ainda ATIVO (status != completed:
 * queued|in_progress|waiting|...). Best-effort: qualquer falha (token ausente,
 * GitHub fora, parse) retorna false -> nao bloqueia (cai no concurrency group).
 */
async function driveRunAtivo(service: ReturnType<typeof createServiceClient>): Promise<boolean> {
  try {
    const { data: token, error } = await service.rpc("github_dispatch_token");
    if (error || typeof token !== "string" || !token) return false;
    const res = await fetch(DRIVE_RUNS_URL, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dlh-core",
      },
    });
    if (!res.ok) return false;
    const json = await res.json();
    const runs = Array.isArray(json?.workflow_runs) ? json.workflow_runs : [];
    return runs.some((r: { status?: string }) => typeof r?.status === "string" && r.status !== "completed");
  } catch (_) {
    return false;
  }
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao primeiro (SEC-02). Sem corpo: as pastas ativas vem do runner.
    const { email } = await requireAuthorizedUser(req);

    const service = createServiceClient();

    // Run do Actions ainda ativo -> 409 limpo (fecha o clique rapido antes de o
    // concurrency group enfileirar um run redundante).
    if (await driveRunAtivo(service)) {
      throw new HttpError(409, "coleta_em_andamento", "ja ha uma coleta do Drive em andamento");
    }

    // Dispara o workflow via RPC (le GITHUB_DISPATCH_TOKEN do Vault server-side).
    const { data: requestId, error } = await service.rpc("disparar_workflow_drive", {
      p_gatilho: "manual",
    });
    if (error) {
      throw new HttpError(502, "drive_dispatch_failed", "falha ao acionar a coleta do Drive");
    }

    await logSensitiveAction({
      tabela: "config_ingestao",
      acao: "disparar_drive",
      registroId: null,
      usuario: email,
      dadosNovos: { fonte: "drive", requestId: requestId ?? null },
    });

    // 202 Accepted: o workflow_dispatch foi aceito; a coleta roda assincrona no
    // runner do GitHub Actions.
    return jsonResponse({ ok: true, requestId: requestId ?? null }, 202);
  } catch (err) {
    return await errorResponse(err, { fn: "drive-disparar" });
  }
}

getEnv();

Deno.serve(handler);
