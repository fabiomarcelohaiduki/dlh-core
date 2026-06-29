// =====================================================================
// Edge Function: descoberta-agendamento  ->  /descoberta-agendamento
// Le e persiste o agendamento da DESCOBERTA (enfileiramento) por fonte na
// tabela config_descoberta (1 linha por fonte) e reescreve o pg_cron
// 'descobrir-<fonte>' via RPC aplicar_agendamento_descoberta(fonte).
//
// A descoberta materializa documento_vinculos (fila de extracao) a partir dos
// dados ja coletados. So o Nomus precisa de relogio proprio (Effecti
// auto-descobre pos-coleta; Gmail/Drive entregam a lista na coleta). O job
// pg_cron chama a Edge documentos-descobrir (X-Cron-Secret) — descoberta
// server-side, sem PC local.
//
//   PUT -> valida e persiste { fonte, ativo, frequencia, horarioReferencia,
//          diaSemana?, diaMes? }, chama aplicar_agendamento_descoberta(fonte) e
//          devolve a expressao cron resultante. Exige sessao autorizada + audit.
//
//   A LEITURA e hidratada server-side (RLS) na pagina (loadAgendamentoDescobertaNomus)
//   — nao ha GET aqui (evita superficie de leitura sem checagem de allowlist).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { descobertaAgendamentoSchema, parseJsonBody } from "../_shared/validation.ts";

async function handlePut(req: Request): Promise<Response> {
  // Sessao autorizada (RLS + audit trail).
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, descobertaAgendamentoSchema);

  const payload = {
    fonte: input.fonte,
    agendamento_ativo: input.ativo,
    frequencia: input.frequencia,
    horario_referencia: input.horarioReferencia ?? null,
    dia_semana: input.diaSemana ?? null,
    dia_mes: input.diaMes ?? null,
    updated_at: new Date().toISOString(),
  };

  // 1 linha por fonte (PK = fonte). Upsert idempotente; a seed ja garante a
  // linha 'nomus', mas o upsert cobre o caso de tabela vazia.
  const { error: upErr } = await db
    .from("config_descoberta")
    .upsert(payload, { onConflict: "fonte" });
  if (upErr) {
    throw new HttpError(500, "agendamento_upsert_failed", "falha ao salvar o agendamento");
  }

  // Reescreve o pg_cron 'descobrir-<fonte>' a partir da config recem-salva.
  const service = createServiceClient();
  const { data: resultado, error: rpcErr } = await service.rpc(
    "aplicar_agendamento_descoberta",
    { p_fonte: input.fonte },
  );
  if (rpcErr) {
    throw new HttpError(500, "cron_apply_failed", "config salva, mas falhou ao reagendar o cron");
  }

  await logSensitiveAction({
    tabela: "config_descoberta",
    acao: "salvar_agendamento_descoberta",
    registroId: null,
    usuario: email,
    dadosNovos: {
      fonte: input.fonte,
      ativo: input.ativo,
      frequencia: input.frequencia,
      horarioReferencia: input.horarioReferencia ?? null,
      diaSemana: input.diaSemana ?? null,
      diaMes: input.diaMes ?? null,
    },
  });

  return jsonResponse({ ok: true, agendamento: resultado ?? null }, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    if (req.method === "PUT") return await handlePut(req);
    throw new HttpError(405, "method_not_allowed", "use PUT");
  } catch (err) {
    return await errorResponse(err, { fn: "descoberta-agendamento" });
  }
}

getEnv();

Deno.serve(handler);
