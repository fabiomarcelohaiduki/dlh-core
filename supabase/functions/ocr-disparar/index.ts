// =====================================================================
// Edge Function: ocr-disparar  ->  POST /ocr-disparar
// Dispara MANUALMENTE o EXTRATOR OCR pelo painel de Extracao (cockpit).
//
// O passo OCR e dedicado (extrair-ocr.yml, EXTRACAO_MODO=ocr): drena SO a fila
// 'precisa_ocr' (escaneados/imagem) com OCR ligado e lote pequeno, separado do
// pipeline rapido (extrair-anexos.yml, OCR off). Como OCR e caro, o disparo e
// SEMPRE manual. Este endpoint aciona o workflow via RPC disparar_workflow_ocr
// (le o GITHUB_DISPATCH_TOKEN do Vault server-side).
//
// Sem corpo. Exige sessao autorizada (requireAuthorizedUser) + audit. Responde
// 202 (aceito; o workflow roda async no runner).
//
// ANTI-DUPLO-DISPARO: o OCR NAO grava linha em execucoes, entao nao ha camada de
// banco. O concurrency group do proprio workflow ja serializa (group:
// extrair-ocr); checamos a GitHub API por runs ativos do extrair-ocr.yml para
// devolver um 409 limpo no clique rapido. Best-effort: qualquer falha degrada
// para so o concurrency group do GitHub.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { workflowRunsUrl } from "../_shared/github.ts";

const OCR_RUNS_URL = workflowRunsUrl("extrair-ocr.yml");

/**
 * True quando ha um run do extrair-ocr.yml ainda ATIVO (status != completed:
 * queued|in_progress|waiting|...). Best-effort: qualquer falha (token ausente,
 * GitHub fora, parse) retorna false -> nao bloqueia (cai no concurrency group).
 */
async function ocrRunAtivo(service: ReturnType<typeof createServiceClient>): Promise<boolean> {
  try {
    const { data: token, error } = await service.rpc("github_dispatch_token");
    if (error || typeof token !== "string" || !token) return false;
    const res = await fetch(OCR_RUNS_URL, {
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

    // Autorizacao primeiro (SEC-02). Sem corpo: a fila 'precisa_ocr' vem do runner.
    const { email } = await requireAuthorizedUser(req);

    const service = createServiceClient();

    // Run do Actions ainda ativo -> 409 limpo (fecha o clique rapido antes de o
    // concurrency group enfileirar um run redundante).
    if (await ocrRunAtivo(service)) {
      throw new HttpError(409, "ocr_em_andamento", "ja ha uma extracao OCR em andamento");
    }

    // Dispara o workflow via RPC (le GITHUB_DISPATCH_TOKEN do Vault server-side).
    const { data: requestId, error } = await service.rpc("disparar_workflow_ocr");
    if (error) {
      throw new HttpError(502, "ocr_dispatch_failed", "falha ao acionar a extracao OCR");
    }

    await logSensitiveAction({
      tabela: "config_extracao",
      acao: "disparar_ocr",
      registroId: null,
      usuario: email,
      dadosNovos: { modo: "ocr", requestId: requestId ?? null },
    });

    // 202 Accepted: o workflow_dispatch foi aceito; o OCR roda assincrono no
    // runner do GitHub Actions.
    return jsonResponse({ ok: true, requestId: requestId ?? null }, 202);
  } catch (err) {
    return await errorResponse(err, { fn: "ocr-disparar" });
  }
}

getEnv();

Deno.serve(handler);
