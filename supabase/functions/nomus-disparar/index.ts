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
import { getFonteByTipo } from "../_shared/vault.ts";
import { workflowRunsUrl } from "../_shared/github.ts";

// Idade maxima do checkpoint.runner_ts para considerar um run VIVO. Acima dela a
// execucao em_andamento e ORFA (run morto por timeout 6h / cancel). Espelha o
// mesmo teto do nomus-ingerir (action "retomar"), unica fonte da regra de stale.
const RUNNER_STALE_MS = 15 * 60_000;

const NOMUS_RUNS_URL = workflowRunsUrl("coletar-nomus.yml");

/**
 * True quando ha um run do coletar-nomus.yml ainda ATIVO (status != completed:
 * queued|in_progress|waiting|...). Cobre a JANELA de setup do runner (~60s entre
 * o dispatch e o 1o push, em que a execucao ainda nao existe no banco) — o run ja
 * aparece como queued no instante do dispatch. Um run morto por timeout/cancel
 * fica status="completed", entao NAO bloqueia (orfa cai na camada de execucoes).
 * Best-effort: qualquer falha (token ausente, GitHub fora, parse) retorna false
 * -> nao bloqueia. NB: nao distingue recurso (a API de runs nao expoe inputs);
 * so 'processos' roda hoje, entao e exato na pratica.
 */
async function nomusRunAtivo(service: ReturnType<typeof createServiceClient>): Promise<boolean> {
  try {
    const { data: token, error } = await service.rpc("github_dispatch_token");
    if (error || typeof token !== "string" || !token) return false;
    const res = await fetch(NOMUS_RUNS_URL, {
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

    // Autorizacao primeiro (SEC-02); corpo validado por allowlist (SEC-03).
    const { email } = await requireAuthorizedUser(req);
    const { modo, recurso } = await parseJsonBody(req, nomusDispararSchema, {
      validationStatus: 422,
    });
    // Recurso/modulo alvo: default 'processos' (unico coletor vivo hoje).
    const recursoAlvo = recurso ?? "processos";

    const service = createServiceClient();

    // Guard anti-duplo-disparo STALE-AWARE: recusa com 409 ANTES de gastar um run
    // do Actions quando ja ha coleta VIVA DESTE recurso. O lock-por-recurso do
    // nomus-ingerir tambem barraria, mas so depois do runner subir e falhar
    // (workflow vermelho, sem feedback no painel). Escopo (fonte_id, recurso)
    // espelha exatamente aquele lock.
    //
    // Diferente do guard ingenuo: uma execucao em_andamento ORFA (run morto por
    // timeout 6h / cancel) NAO pode prender o botao para sempre. Aplica a mesma
    // regra de stale do nomus-ingerir (action "retomar"): runner_ts FRESCO = run
    // vivo (409); runner_ts velho/ausente = orfa, auto-cura conforme o modo.
    const fonte = await getFonteByTipo("nomus");
    const { data: emAndamento, error: andamentoError } = await service
      .from("execucoes")
      .select("id, checkpoint")
      .eq("status", "em_andamento")
      .eq("fonte_id", fonte.id)
      .eq("recurso", recursoAlvo)
      .order("inicio", { ascending: false })
      .limit(1);
    if (andamentoError) {
      throw new HttpError(500, "execucao_query_failed", "falha ao verificar execucoes em andamento");
    }
    if (emAndamento && emAndamento.length > 0) {
      const row = emAndamento[0] as { id: string; checkpoint: unknown };
      const cp = row.checkpoint && typeof row.checkpoint === "object"
        ? row.checkpoint as Record<string, unknown>
        : {};
      const runnerTs = typeof cp.runner_ts === "string" ? Date.parse(cp.runner_ts) : NaN;
      const idadeMs = Number.isFinite(runnerTs) ? Date.now() - runnerTs : Infinity;
      if (idadeMs < RUNNER_STALE_MS) {
        // Run ATIVO de verdade: nao pisar.
        throw new HttpError(409, "execucao_em_andamento", "ja ha uma coleta do Nomus em andamento");
      }
      // ORFA: o lock travou num run morto. Auto-cura para liberar o botao,
      // PRESERVANDO o cursor de backfill quando faz sentido:
      //   - full: NAO fecha a orfa aqui. O fetchRetomar do runner le o
      //     runner_pagina dela e retoma o backfill da proxima pagina; fechar
      //     agora perderia o cursor (recomecaria da pagina 1).
      //   - incremental: nao tem cursor (varre por watermark). Fecha a orfa
      //     (status 'erro') para o 1o push do runner nao bater no lock-por-
      //     recurso do nomus-ingerir (409 -> workflow vermelho).
      if (modo === "incremental") {
        await service
          .from("execucoes")
          .update({ status: "erro", etapa_atual: null, fim: new Date().toISOString() })
          .eq("id", row.id)
          .eq("status", "em_andamento");
      }
    }

    // Camada (2) STALE-AWARE-SAFE: run do Actions ainda ativo na janela de setup
    // do runner (antes de a execucao nascer no banco). Fecha o duplo-disparo por
    // clique rapido — o run aparece como queued no instante do dispatch. Um run
    // morto (timeout/cancel) ja e status="completed" aqui, entao NAO bloqueia a
    // retomada de uma orfa (essa cai na camada 1 acima). Best-effort: se a API
    // falhar, segue so com a camada 1.
    if (await nomusRunAtivo(service)) {
      throw new HttpError(409, "execucao_em_andamento", "ja ha uma coleta do Nomus em andamento");
    }

    // Dispara o workflow via RPC (le GITHUB_DISPATCH_TOKEN do Vault server-side).
    const { data: requestId, error } = await service.rpc("disparar_workflow_nomus", {
      p_modo: modo,
      p_recurso: recursoAlvo,
      p_gatilho: "manual",
    });
    if (error) {
      throw new HttpError(502, "nomus_dispatch_failed", "falha ao acionar o workflow do Nomus");
    }

    await logSensitiveAction({
      tabela: "fontes",
      acao: "disparar_coleta_nomus",
      registroId: null,
      usuario: email,
      dadosNovos: { fonte: "nomus", modo, recurso: recursoAlvo, requestId: requestId ?? null },
    });

    // 202 Accepted: o workflow_dispatch foi aceito; a coleta roda assincrona
    // no runner do GitHub Actions (visibilidade pelo painel/heartbeat).
    return jsonResponse({ ok: true, modo, recurso: recursoAlvo, requestId: requestId ?? null }, 202);
  } catch (err) {
    return await errorResponse(err, { fn: "nomus-disparar" });
  }
}

getEnv();

Deno.serve(handler);
