// =====================================================================
// Edge Function: comando-local-fila  ->  POST /comando-local-fila
// Ponta do PC do quadro de avisos: o servico de poll local pega e sela comandos.
//
// POR QUE EXISTE (decisao Fabio 2026-06-28):
//   A coleta Nomus e a extracao Tika/OCR rodam no PC do Fabio. O cockpit so
//   ENFILEIRA (Edge comando-local-enfileirar). Esta Edge e onde o PC consome a
//   fila: action 'pegar' tira atomicamente o proximo pendente (FOR UPDATE SKIP
//   LOCKED via RPC) e o marca 'executando'; action 'concluir' sela o resultado
//   (concluido|erro + cauda do log). Nenhuma execucao roda aqui; quem executa e
//   o servico de poll do PC chamando os wrappers .ps1.
//
// AUTENTICACAO: X-Cron-Secret (matchesCronSecret) — o PC nao tem service_role,
//   so o cron secret (igual aos coletores). verify_jwt DESLIGADO no config.toml
//   (chamada sem header Authorization -> o gateway barraria antes do codigo).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { matchesCronSecret } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";

const STATUS_FINAIS = ["concluido", "erro"] as const;
type StatusFinal = (typeof STATUS_FINAIS)[number];

function ehStatusFinal(v: unknown): v is StatusFinal {
  return typeof v === "string" && (STATUS_FINAIS as readonly string[]).includes(v);
}

/** action 'pegar': pega atomicamente o proximo pendente e marca executando. */
async function pegar(service: ReturnType<typeof createServiceClient>): Promise<Response> {
  const { data, error } = await service.rpc("comando_local_pegar");
  if (error) {
    throw new HttpError(500, "fila_pegar_failed", "falha ao pegar o proximo comando");
  }
  // A RPC retorna tipo composto: com a fila vazia (RETURN null no plpgsql) o
  // PostgREST serializa uma LINHA de campos null, nao um null real. Normaliza
  // para null quando nao ha id, para o contrato ser limpo (comando: null).
  const row = data as { id?: string | null } | null;
  return jsonResponse({ comando: row && row.id ? row : null });
}

/** action 'concluir': sela o comando (concluido|erro) com a cauda do log. */
async function concluir(
  body: { id?: unknown; status?: unknown; resultado?: unknown },
  service: ReturnType<typeof createServiceClient>,
): Promise<Response> {
  if (typeof body.id !== "string" || !body.id) {
    throw new HttpError(400, "id_invalido", "id do comando obrigatorio");
  }
  if (!ehStatusFinal(body.status)) {
    throw new HttpError(400, "status_invalido", "status deve ser concluido ou erro");
  }
  const resultado = typeof body.resultado === "string" ? body.resultado.slice(0, 4000) : null;

  const { data, error } = await service
    .from("comando_local")
    .update({ status: body.status, resultado, terminado_em: new Date().toISOString() })
    .eq("id", body.id)
    .eq("status", "executando")
    .select("id")
    .single();
  if (error || !data) {
    throw new HttpError(409, "comando_nao_executando", "comando inexistente ou nao esta em execucao");
  }

  return jsonResponse({ ok: true, id: data.id });
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    if (!(await matchesCronSecret(req))) {
      throw new HttpError(401, "no_auth", "cron secret invalido ou ausente");
    }

    let body: { action?: unknown; id?: unknown; status?: unknown; resultado?: unknown };
    try {
      body = await req.json();
    } catch (_) {
      throw new HttpError(400, "body_invalido", "corpo JSON invalido");
    }

    const service = createServiceClient();
    if (body.action === "pegar") return await pegar(service);
    if (body.action === "concluir") return await concluir(body, service);
    throw new HttpError(400, "action_invalida", "action deve ser pegar ou concluir");
  } catch (err) {
    return await errorResponse(err, { fn: "comando-local-fila" });
  }
}

getEnv();

Deno.serve(handler);
