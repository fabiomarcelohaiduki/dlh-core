// =====================================================================
// Edge Function: agendamento-fonte-config  ->  /agendamento-fonte-config
// Le e persiste o agendamento POR FONTE (na config_ingestao da fonte) e
// reescreve o pg_cron via RPC aplicar_agendamento_fonte(tipo) (decisao 09/06).
// Substitui o ciclo GLOBAL (agendamento-config): cada fonte tem seu relogio.
//
//   GET ?fonte=effecti -> retorna o agendamento atual da fonte (popula o card).
//   PUT  -> valida e persiste { fonte, ativo, frequencia, horarioReferencia,
//           diaSemana?, diaMes? }, chama aplicar_agendamento_fonte(fonte) e
//           devolve a expressao cron resultante. Exige sessao autorizada + audit.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  agendamentoFonteConfigSchema,
  parseFonteAgendavelParam,
  parseJsonBody,
} from "../_shared/validation.ts";

interface ConfigRow {
  id: string;
  agendamento_ativo: boolean;
  frequencia: string;
  horario_referencia: string | null;
  dia_semana: number | null;
  dia_mes: number | null;
}

/** Resolve o id da fonte pelo tipo (effecti|nomus|gmail); 404 quando ausente. */
async function fonteIdPorTipo(
  service: ReturnType<typeof createServiceClient>,
  tipo: string,
): Promise<string> {
  const { data, error } = await service
    .from("fontes")
    .select("id")
    .eq("tipo", tipo)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "fonte_query_failed", "falha ao consultar a fonte");
  }
  const row = data as { id: string } | null;
  if (!row?.id) {
    throw new HttpError(404, "fonte_nao_encontrada", `fonte ${tipo} nao cadastrada`);
  }
  return row.id;
}

async function handleGet(req: Request): Promise<Response> {
  const fonte = parseFonteAgendavelParam(new URL(req.url).searchParams.get("fonte"));
  const service = createServiceClient();
  const fonteId = await fonteIdPorTipo(service, fonte);

  const { data, error } = await service
    .from("config_ingestao")
    .select("id, agendamento_ativo, frequencia, horario_referencia, dia_semana, dia_mes")
    .eq("fonte_id", fonteId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "agendamento_query_failed", "falha ao consultar o agendamento");
  }
  const row = data as ConfigRow | null;
  return jsonResponse(
    {
      fonte,
      ativo: row?.agendamento_ativo ?? false,
      frequencia: row?.frequencia ?? "manual",
      horarioReferencia: row?.horario_referencia ?? null,
      diaSemana: row?.dia_semana ?? null,
      diaMes: row?.dia_mes ?? null,
    },
    200,
  );
}

async function handlePut(req: Request): Promise<Response> {
  // Sessao autorizada (RLS + audit trail).
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, agendamentoFonteConfigSchema);

  const service = createServiceClient();
  const fonteId = await fonteIdPorTipo(service, input.fonte);

  const payload = {
    agendamento_ativo: input.ativo,
    frequencia: input.frequencia,
    horario_referencia: input.horarioReferencia ?? null,
    dia_semana: input.diaSemana ?? null,
    dia_mes: input.diaMes ?? null,
    updated_at: new Date().toISOString(),
  };

  // config_ingestao e por fonte: atualiza a linha existente. Sem linha (fonte
  // ainda sem config salva) cria com defaults inertes para os filtros — janela
  // e filtros sao geridos pelo cmp-cfg-form; aqui so o agendamento.
  const { data: existing, error: selErr } = await db
    .from("config_ingestao")
    .select("id")
    .eq("fonte_id", fonteId)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "agendamento_query_failed", "falha ao consultar o agendamento");
  }

  if (existing?.id) {
    const { error: updErr } = await db
      .from("config_ingestao")
      .update(payload)
      .eq("id", (existing as { id: string }).id);
    if (updErr) {
      throw new HttpError(500, "agendamento_update_failed", "falha ao salvar o agendamento");
    }
  } else {
    const { error: insErr } = await db.from("config_ingestao").insert({
      fonte_id: fonteId,
      janela_dias: 15,
      modalidades: [],
      portais: [],
      ...payload,
    });
    if (insErr) {
      throw new HttpError(500, "agendamento_insert_failed", "falha ao criar o agendamento");
    }
  }

  // Reescreve o pg_cron coleta-<tipo> a partir da config recem-salva.
  const { data: resultado, error: rpcErr } = await service.rpc("aplicar_agendamento_fonte", {
    p_fonte_tipo: input.fonte,
  });
  if (rpcErr) {
    throw new HttpError(500, "cron_apply_failed", "config salva, mas falhou ao reagendar o cron");
  }

  await logSensitiveAction({
    tabela: "config_ingestao",
    acao: "salvar_agendamento_fonte",
    registroId: existing?.id ?? null,
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
    if (req.method === "GET") return await handleGet(req);
    if (req.method === "PUT") return await handlePut(req);
    throw new HttpError(405, "method_not_allowed", "use GET ou PUT");
  } catch (err) {
    return await errorResponse(err, { fn: "agendamento-fonte-config" });
  }
}

getEnv();

Deno.serve(handler);
