// =====================================================================
// Edge Function: ocr-agendamento  ->  /ocr-agendamento
// Le e persiste o agendamento do EXTRATOR OCR (passo dedicado) nas colunas
// ocr_* do singleton config_extracao e reescreve o pg_cron 'extrair-ocr' via
// RPC aplicar_agendamento_ocr() (decisao 16/06).
//
// O OCR e um passo SEPARADO do extrator rapido: drena SO a fila 'precisa_ocr'
// (escaneados/imagem) com OCR ligado. Ate aqui so tinha disparo manual; agora
// ganha agendamento administravel pelo cockpit. As colunas ocr_* vivem na MESMA
// linha do agendamento da extracao, mas com nomes DISTINTOS (prefixo ocr_) pra
// nao sobrescrever o agendamento do extrator rapido — cada PUT toca so as suas.
//
//   PUT -> valida e persiste { ativo, frequencia, horarioReferencia,
//          diaSemana?, diaMes? }, chama aplicar_agendamento_ocr() e devolve a
//          expressao cron resultante. Exige sessao autorizada + audit.
//
//   A LEITURA e hidratada server-side (RLS) na pagina, igual ao extracao-config
//   — nao ha GET aqui.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { extracaoAgendamentoSchema, parseJsonBody } from "../_shared/validation.ts";

async function handlePut(req: Request): Promise<Response> {
  // Sessao autorizada (RLS + audit trail). Reusa o schema do agendamento da
  // extracao: a forma do payload e identica (ativo/frequencia/horario/dia).
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, extracaoAgendamentoSchema);

  const payload = {
    ocr_agendamento_ativo: input.ativo,
    ocr_frequencia: input.frequencia,
    ocr_horario_referencia: input.horarioReferencia ?? null,
    ocr_dia_semana: input.diaSemana ?? null,
    ocr_dia_mes: input.diaMes ?? null,
    updated_at: new Date().toISOString(),
  };

  // Singleton: atualiza a unica linha; cria se (por algum motivo) nao existir.
  // So toca as colunas ocr_* — o agendamento do extrator rapido fica intacto.
  const { data: existing, error: selErr } = await db
    .from("config_extracao")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "agendamento_query_failed", "falha ao consultar o agendamento");
  }
  const existingRow = existing as { id: string } | null;

  if (existingRow?.id) {
    const { error: updErr } = await db
      .from("config_extracao")
      .update(payload)
      .eq("id", existingRow.id);
    if (updErr) {
      throw new HttpError(500, "agendamento_update_failed", "falha ao salvar o agendamento");
    }
  } else {
    const { error: insErr } = await db.from("config_extracao").insert(payload);
    if (insErr) {
      throw new HttpError(500, "agendamento_insert_failed", "falha ao criar o agendamento");
    }
  }

  // Reescreve o pg_cron 'extrair-ocr' a partir da config recem-salva.
  const service = createServiceClient();
  const { data: resultado, error: rpcErr } = await service.rpc("aplicar_agendamento_ocr");
  if (rpcErr) {
    throw new HttpError(500, "cron_apply_failed", "config salva, mas falhou ao reagendar o cron");
  }

  await logSensitiveAction({
    tabela: "config_extracao",
    acao: "salvar_agendamento_ocr",
    registroId: existingRow?.id ?? null,
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
    if (req.method === "PUT") return await handlePut(req);
    throw new HttpError(405, "method_not_allowed", "use PUT");
  } catch (err) {
    return await errorResponse(err, { fn: "ocr-agendamento" });
  }
}

getEnv();

Deno.serve(handler);
