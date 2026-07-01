// =====================================================================
// Edge Function: relacionamentos-reprocessar  ->  POST /relacionamentos-reprocessar
//
// Botao "Reprocessar relacionamentos" do cockpit. Reaproveita integralmente
// o pipeline de 3 fases de `relacionamentos-backfill` (helper compartilhado
// em `_shared/relacionamentos-backfill.ts`), porem:
//
//   - NAO aceita `X-Cron-Secret` - caminho exclusivamente humano. Sessao
//     validada via `requireAuthorizedUser` (Bearer + allowlist
//     `contas_autorizadas` via service_role).
//   - Grava `execucoes.gatilho='manual'` (telemetria do disparo humano).
//   - Registra o disparo em `audit_log` via `logSensitiveAction`
//     (`acao='relacionamentos_backfill_disparo'`) com o email do operador,
//     em complemento a `execucoes` (RF-15, US-09 CA-04). A auditoria NAO
//     substitui o retorno do job - ela e adicional e best-effort
//     (`logSensitiveAction` nunca derruba o fluxo).
//
// Single-flight identico ao `relacionamentos-backfill`: 409 com codigo
// `execucao_em_andamento` quando ja ha run ativo (consulta
// `etapa_atual='relacionamentos-backfill' AND status='em_andamento'`).
//
// Resposta JSON: resultado completo de runRelacionamentosBackfill.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  execucaoBackfillAtiva,
  resolverOrgAtivaBackfill,
  runRelacionamentosBackfill,
} from "../_shared/relacionamentos-backfill.ts";

const FUNCTION_SEGMENT = "relacionamentos-reprocessar";

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    // Borda: metodo antes da autenticacao; autenticacao antes do corpo.
    assertMethod(req, "POST");
    // Caminho EXCLUSIVAMENTE humano - NAO aceita X-Cron-Secret.
    const { email, user } = await requireAuthorizedUser(req);

    const db = createServiceClient();

    // Single-flight identico ao `relacionamentos-backfill` (cron).
    const ativa = await execucaoBackfillAtiva(db);
    if (ativa) {
      throw new HttpError(
        409,
        "execucao_em_andamento",
        "ja existe um backfill de relacionamentos em andamento",
        { execucao_id: ativa },
      );
    }

    // Auditoria do disparo humano (best-effort). Ocorre ANTES do run
    // propriamente dito para que o `audit_log` registre a intencao mesmo
    // em caso de erro subsequente. Falha na auditoria NAO derruba o
    // fluxo (logSensitiveAction nunca propaga).
    await logSensitiveAction({
      tabela: "relacoes",
      acao: "relacionamentos_backfill_disparo",
      usuario: email,
      dadosNovos: {
        origem: "botao_reprocessar_cockpit",
        execucao_etapa: "relacionamentos-backfill",
        execucao_gatilho: "manual",
      },
    });

    const resultado = await runRelacionamentosBackfill({
      db,
      etapa: FUNCTION_SEGMENT,
      gatilho: "manual",
      orgId: await resolverOrgAtivaBackfill({
        db,
        usuarioId: user.id,
      }),
    });

    return jsonResponse(resultado, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
