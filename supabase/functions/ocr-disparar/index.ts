// =====================================================================
// Edge Function: ocr-disparar  ->  POST /ocr-disparar
// Dispara MANUALMENTE o OCR pelo cockpit ("Extrair OCR agora").
//
// MIGRACAO LOCAL (decisao Fabio 2026-06-29): no PC, o OCR NAO e um passo
// separado. O wrapper extrair-tika.ps1 roda a extracao rapida (Tika) SEGUIDA do
// passo OCR na MESMA execucao, sob o unico comando 'tika-ocr'. Logo este
// endpoint CONVERGE para o mesmo comando que o extracao-disparar: enfileira
// 'tika-ocr' na fila comando_local (o servico de poll do PC executa). O antigo
// disparo do workflow extrair-ocr.yml foi aposentado (sem GitHub Actions).
//
// Sem corpo. Exige sessao autorizada (requireAuthorizedUser) + audit. Responde
// 202 (aceito; o PC pega o comando no proximo poll).
//
// ANTI-DUPLO-DISPARO: 409 limpo se ja ha um 'tika-ocr' pendente ou executando na
// fila. Como Tika e OCR sao o mesmo comando, disparar OCR enquanto uma extracao
// roda devolve 409 (o run unico ja cobre os escaneados).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao primeiro (SEC-02). Sem corpo: a fila 'precisa_ocr' vem do PC.
    const { email } = await requireAuthorizedUser(req);

    const service = createServiceClient();

    // Anti-duplo-disparo: nao empilha outro 'tika-ocr' se um ja esta na fila ou
    // rodando no PC (o run unico cobre Tika + OCR).
    const { data: ativos, error: ativosErr } = await service
      .from("comando_local")
      .select("id")
      .eq("comando", "tika-ocr")
      .in("status", ["pendente", "executando"])
      .limit(1);
    if (ativosErr) {
      throw new HttpError(500, "fila_query_failed", "falha ao verificar a fila de extracao");
    }
    if (ativos && ativos.length > 0) {
      throw new HttpError(409, "ocr_em_andamento", "ja ha uma extracao OCR em andamento");
    }

    // Enfileira o comando para o PC executar (extrair-tika.ps1: Tika + OCR).
    const { data: inserido, error } = await service
      .from("comando_local")
      .insert({ comando: "tika-ocr", solicitado_por: email })
      .select("id, comando, status, solicitado_em")
      .single();
    if (error || !inserido) {
      throw new HttpError(500, "ocr_enqueue_failed", "falha ao enfileirar a extracao OCR");
    }

    await logSensitiveAction({
      tabela: "comando_local",
      acao: "disparar_ocr",
      registroId: inserido.id,
      usuario: email,
      dadosNovos: { comando: "tika-ocr", modo: "ocr" },
    });

    // 202 Accepted: comando aceito; o PC roda a extracao no proximo poll.
    return jsonResponse({ ok: true, comando: inserido }, 202);
  } catch (err) {
    return await errorResponse(err, { fn: "ocr-disparar" });
  }
}

getEnv();

Deno.serve(handler);
