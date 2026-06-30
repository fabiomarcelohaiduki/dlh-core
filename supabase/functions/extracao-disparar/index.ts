// =====================================================================
// Edge Function: extracao-disparar  ->  POST /extracao-disparar
// Dispara MANUALMENTE a EXTRACAO (Tika) pelo cockpit ("Extrair pendentes agora").
//
// MIGRACAO LOCAL (decisao Fabio 2026-06-29): pos-bloqueio do GitHub Actions, a
// extracao Tika/OCR roda no PC do Fabio. Este endpoint deixou de disparar o
// workflow extrair-anexos.yml e passa a ENFILEIRAR o comando 'tika-ocr' na fila
// comando_local (o servico de poll do PC pega e roda extrair-tika.ps1: extracao
// rapida + OCR na MESMA execucao). Mesma cadeia do disparo agendado pelo pg_cron
// (aplicar_agendamento_extracao). O OCR nao tem disparo separado no PC: o mesmo
// comando 'tika-ocr' cobre as duas camadas (ver ocr-disparar, que converge aqui).
//
// Sem corpo (a fila inteira de documento_vinculos pendentes vem do PC). Exige
// sessao autorizada (requireAuthorizedUser) + audit. Responde 202 (aceito; o PC
// pega o comando no proximo poll).
//
// ANTI-DUPLO-DISPARO: 409 limpo se ja ha um 'tika-ocr' pendente ou executando na
// fila (fecha o clique rapido antes de empilhar uma extracao redundante).
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

    // Autorizacao primeiro (SEC-02). Sem corpo: a fila vem do PC.
    const { email } = await requireAuthorizedUser(req);

    const service = createServiceClient();

    // Anti-duplo-disparo: nao empilha outro 'tika-ocr' se um ja esta na fila ou
    // rodando no PC (clique rapido -> 409 limpo).
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
      throw new HttpError(409, "extracao_em_andamento", "ja ha uma extracao em andamento");
    }

    // Enfileira o comando para o PC executar (extrair-tika.ps1: Tika + OCR).
    const { data: inserido, error } = await service
      .from("comando_local")
      .insert({ comando: "tika-ocr", solicitado_por: email })
      .select("id, comando, status, solicitado_em")
      .single();
    if (error || !inserido) {
      throw new HttpError(500, "extracao_enqueue_failed", "falha ao enfileirar a extracao");
    }

    await logSensitiveAction({
      tabela: "comando_local",
      acao: "disparar_extracao",
      registroId: inserido.id,
      usuario: email,
      dadosNovos: { comando: "tika-ocr" },
    });

    // 202 Accepted: comando aceito; o PC roda a extracao no proximo poll.
    return jsonResponse({ ok: true, comando: inserido }, 202);
  } catch (err) {
    return await errorResponse(err, { fn: "extracao-disparar" });
  }
}

getEnv();

Deno.serve(handler);
