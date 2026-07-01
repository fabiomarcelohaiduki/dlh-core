// =====================================================================
// Edge Function: relacionamentos-backfill  ->  POST /relacionamentos-backfill
//
// Backfill deterministico da feature Relacionamentos (Fase 1 / SPEC
// secao 3.2.1). Disparado por DUAS origens mutuamente exclusivas na borda:
//
//   1) CRON: pg_cron diario 00:00 -> `public.disparar_relacionamentos_backfill`
//      faz net.http_post com header X-Cron-Secret (validado por
//      `matchesCronSecret` contra `CRON_DISPATCH_SECRET` no Vault).
//   2) MANUAL: humano autorizado chama via botao "Reprocessar" do cockpit.
//      Valida via `requireAuthorizedUser` (Bearer + allowlist).
//
// A credencial que chega PRIMEIRO define `execucoes.gatilho`: cron -> 'agendada',
// sessao humana -> 'manual'. Em ambos os caminhos grava
// `execucoes.etapa_atual='relacionamentos-backfill'`.
//
// Single-flight: antes de iniciar, consulta `execucoes` com
// `etapa_atual='relacionamentos-backfill' AND status='em_andamento'`. Se
// houver, retorna 409 com codigo `execucao_em_andamento`. O indice
// `uidx_execucoes_uma_ativa_por_fonte` NAO cobre esta chave (etapa_atual e
// o lock), entao a consulta e a rede de seguranca da aplicacao.
//
// Logica do backfill propriamente dito (3 fases: estrutural, regras ativas,
// Triagem) vive em `_shared/relacionamentos-backfill.ts` e e compartilhada
// com `relacionamentos-reprocessar`.
//
// Resposta JSON: { arestas_criadas, arestas_duplicadas, erros_por_macro,
// duracao_ms, execucao_id }. Backfill automatico NAO grava em `audit_log`
// (apenas em `execucoes`).
//
// Idempotencia: todos os inserts em `relacoes` usam ON CONFLICT
// (origem_tipo, origem_id, destino_tipo, destino_id, relacao) DO NOTHING
// (RNF-05). Falha em sub-rotina NAO derruba o job (RNF-11).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { matchesCronSecret, requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  execucaoBackfillAtiva,
  resolverOrgAtivaBackfill,
  runRelacionamentosBackfill,
} from "../_shared/relacionamentos-backfill.ts";

const FUNCTION_SEGMENT = "relacionamentos-backfill";

/**
 * Resultado da autenticacao na borda. `gatilho` segue o tipo de credencial
 * que chegou primeiro: 'agendada' para cron (X-Cron-Secret valido) ou
 * 'manual' para sessao humana autorizada. Quando humano, `usuarioId` e o
 * id do operador (auth.users.id) usado para resolver a org ativa.
 */
type AuthOutcome =
  | {
    ok: true;
    gatilho: "agendada" | "manual";
    usuarioId: string | null;
  }
  | { ok: false; status: number; code: string; message: string };

/**
 * Tenta autenticar a requisicao: primeiro como cron (X-Cron-Secret), depois
 * como humano autorizado. Se ambos falharem, retorna 401. Caso ambos
 * sejam fornecidos (situacao hibrida improvavel), o cron vence - e o que
 * a Edge realmente e (servico interno).
 */
async function autenticar(req: Request): Promise<AuthOutcome> {
  // Caminho 1: cron secret (consulta Vault; pode falhar por I/O).
  if (await matchesCronSecret(req)) {
    return { ok: true, gatilho: "agendada", usuarioId: null };
  }
  // Caminho 2: sessao humana autorizada.
  try {
    const ctx = await requireAuthorizedUser(req);
    return { ok: true, gatilho: "manual", usuarioId: ctx.user.id };
  } catch (err) {
    if (err instanceof HttpError) {
      return {
        ok: false,
        status: err.status,
        code: err.code,
        message: err.message,
      };
    }
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "autenticacao requerida: cron secret ou sessao humana",
    };
  }
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    // Borda: metodo antes da autenticacao; autenticacao antes da execucao.
    assertMethod(req, "POST");
    const auth = await autenticar(req);
    if (!auth.ok) {
      // Re-codifica como HttpError para cair no errorResponse padronizado.
      throw new HttpError(auth.status, auth.code, auth.message);
    }

    const db = createServiceClient();

    // Single-flight: se ja ha execucao 'relacionamentos-backfill' em_andamento,
    // responde 409 com codigo `execucao_em_andamento`. O unico writer desta
    // etapa somos nos, entao a consulta cobre o cenario normal. Em corrida
    // TOCTOU a unicidade do registro inserido pela segunda requisicao pode
    // falhar; nesse caso caimos em 500 (defesa em profundidade documentada).
    const ativa = await execucaoBackfillAtiva(db);
    if (ativa) {
      throw new HttpError(
        409,
        "execucao_em_andamento",
        "ja existe um backfill de relacionamentos em andamento",
        { execucao_id: ativa },
      );
    }

    const resultado = await runRelacionamentosBackfill({
      db,
      etapa: FUNCTION_SEGMENT,
      gatilho: auth.gatilho,
      orgId: await resolverOrgAtivaBackfill({
        db,
        usuarioId: auth.usuarioId,
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
