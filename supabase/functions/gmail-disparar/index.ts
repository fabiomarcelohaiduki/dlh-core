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
//
// ANTI-DUPLO-DISPARO em DUAS camadas (a coleta nasce no runner do Actions, nao
// no banco -> a execucao so existe ~60s depois do dispatch):
//   (1) tabela execucoes em_andamento (pega quando o runner ja abriu a coleta);
//   (2) GitHub API por runs ativos do coletar-gmail.yml (pega a JANELA de setup
//       do runner — o run aparece como queued no instante do dispatch). Fecha o
//       buraco em que um 2o clique enfileirava um run redundante. Degrada
//       gracioso: se a API/token falhar, segue so com a camada (1).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { getFonteByTipo } from "../_shared/vault.ts";

const GMAIL_RUNS_URL =
  "https://api.github.com/repos/fabiomarcelohaiduki/dlh-core/actions/workflows/coletar-gmail.yml/runs?per_page=10";

/**
 * True quando ha um run do coletar-gmail.yml ainda ATIVO (status != completed:
 * queued|in_progress|waiting|...). Cobre a janela em que o runner ainda nao
 * registrou a execucao no banco. Best-effort: qualquer falha (token ausente,
 * GitHub fora, parse) retorna false -> nao bloqueia (cai na camada de execucoes).
 */
async function gmailRunAtivo(service: ReturnType<typeof createServiceClient>): Promise<boolean> {
  try {
    const { data: token, error } = await service.rpc("github_dispatch_token");
    if (error || typeof token !== "string" || !token) return false;
    const res = await fetch(GMAIL_RUNS_URL, {
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

    // Autorizacao primeiro (SEC-02). Sem corpo: a janela vem do gmail-config.
    const { email } = await requireAuthorizedUser(req);

    const service = createServiceClient();

    // Camada (1): execucao em_andamento no banco (runner ja registrou a coleta).
    const fonte = await getFonteByTipo("gmail");
    const { data: emAndamento, error: andamentoError } = await service
      .from("execucoes")
      .select("id")
      .eq("status", "em_andamento")
      .eq("fonte_id", fonte.id)
      .limit(1);
    if (andamentoError) {
      throw new HttpError(500, "execucao_query_failed", "falha ao verificar execucoes em andamento");
    }
    if (emAndamento && emAndamento.length > 0) {
      throw new HttpError(409, "execucao_em_andamento", "ja ha uma coleta do Gmail em andamento");
    }

    // Camada (2): run do Actions ainda ativo (janela de setup do runner, antes
    // de a execucao nascer no banco). Fecha o duplo-disparo por clique rapido.
    if (await gmailRunAtivo(service)) {
      throw new HttpError(409, "execucao_em_andamento", "ja ha uma coleta do Gmail em andamento");
    }

    // Dispara o workflow via RPC (le GITHUB_DISPATCH_TOKEN do Vault server-side).
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
