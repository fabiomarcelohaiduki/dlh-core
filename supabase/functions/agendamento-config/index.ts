// =====================================================================
// Edge Function: agendamento-config  ->  /agendamento/config
// Le e persiste o agendamento GLOBAL do ciclo (singleton) e reescreve o
// pg_cron via RPC aplicar_agendamento() (decisao 06/06).
//
//   GET  -> retorna a config atual do ciclo (para popular o painel).
//   PUT  -> valida e persiste { ativo, frequencia, horarioReferencia,
//           diaSemana?, diaMes? }, chama aplicar_agendamento() e devolve
//           a expressao cron resultante. Exige sessao autorizada + audit.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { agendamentoConfigSchema, parseJsonBody } from "../_shared/validation.ts";

interface AgendamentoRow {
  id: string;
  ativo: boolean;
  frequencia: string;
  horario_referencia: string | null;
  dia_semana: number | null;
  dia_mes: number | null;
  timezone: string;
}

async function handleGet(): Promise<Response> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("config_agendamento")
    .select("id, ativo, frequencia, horario_referencia, dia_semana, dia_mes, timezone")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "agendamento_query_failed", "falha ao consultar o agendamento");
  }
  const row = data as AgendamentoRow | null;
  return jsonResponse(
    {
      ativo: row?.ativo ?? false,
      frequencia: row?.frequencia ?? "manual",
      horarioReferencia: row?.horario_referencia ?? null,
      diaSemana: row?.dia_semana ?? null,
      diaMes: row?.dia_mes ?? null,
      timezone: row?.timezone ?? "America/Sao_Paulo",
    },
    200,
  );
}

async function handlePut(req: Request): Promise<Response> {
  // Sessao autorizada (RLS + audit trail).
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, agendamentoConfigSchema);

  const payload = {
    ativo: input.ativo,
    frequencia: input.frequencia,
    horario_referencia: input.horarioReferencia ?? null,
    dia_semana: input.diaSemana ?? null,
    dia_mes: input.diaMes ?? null,
    updated_at: new Date().toISOString(),
  };

  // Singleton: atualiza a unica linha; cria se (por algum motivo) nao existir.
  const { data: existing, error: selErr } = await db
    .from("config_agendamento")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "agendamento_query_failed", "falha ao consultar o agendamento");
  }

  if (existing?.id) {
    const { error: updErr } = await db
      .from("config_agendamento")
      .update(payload)
      .eq("id", (existing as { id: string }).id);
    if (updErr) {
      throw new HttpError(500, "agendamento_update_failed", "falha ao salvar o agendamento");
    }
  } else {
    const { error: insErr } = await db.from("config_agendamento").insert(payload);
    if (insErr) {
      throw new HttpError(500, "agendamento_insert_failed", "falha ao criar o agendamento");
    }
  }

  // Reescreve o pg_cron a partir da config recem-salva (server-side only).
  const service = createServiceClient();
  const { data: resultado, error: rpcErr } = await service.rpc("aplicar_agendamento");
  if (rpcErr) {
    throw new HttpError(500, "cron_apply_failed", "config salva, mas falhou ao reagendar o cron");
  }

  await logSensitiveAction({
    tabela: "config_agendamento",
    acao: "salvar_agendamento",
    registroId: existing?.id ?? null,
    usuario: email,
    dadosNovos: {
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
    if (req.method === "GET") return await handleGet();
    if (req.method === "PUT") return await handlePut(req);
    throw new HttpError(405, "method_not_allowed", "use GET ou PUT");
  } catch (err) {
    return await errorResponse(err, { fn: "agendamento-config" });
  }
}

getEnv();

Deno.serve(handler);
