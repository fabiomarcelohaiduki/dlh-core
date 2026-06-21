// =====================================================================
// Edge Function: effecti-painel-cred  ->  PUT /effecti-painel-cred
// Grava a credencial do PAINEL WEB da Effecti (usuario+senha) no Supabase
// Vault como SEGREDO DE SERVICO (RNF-02). Habilita o login programatico
// (usuario/senha -> JWT) que abre o endpoint /all com a lista COMPLETA de
// itens por edital (recall total), que a API de integracao por token nao
// entrega.
//
//   - Autoriza a sessao (requireAuthorizedUser) ANTES de ler o corpo (SEC-02):
//     sem sessao -> 401.
//   - Valida o corpo com zod (SEC-03): username/password nao-vazios.
//     Valor fora dos limites -> 422 SEM nenhum I/O externo.
//   - Grava no Vault via set_service_secret pelo nome deterministico
//     EFFECTI_PAINEL_CRED (JSON {username,password}) e marca a flag de presenca
//     fontes.painel_cred_em = now() na fonte Effecti; o segredo NUNCA volta ao
//     cliente nem vai para log (SEC-01/RNF-02).
//   - Responde { ok } e audita a acao SEM o segredo.
//   - Fonte Effecti inexistente -> 404 (getFonteByTipo).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { effectiPainelCredSchema, parseJsonBody } from "../_shared/validation.ts";
import {
  EFFECTI_PAINEL_CRED_KEY_NAME,
  getFonteByTipo,
  setServiceSecret,
} from "../_shared/vault.ts";

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "PUT");

    // Autorizacao primeiro: nao processa corpo sem sessao valida (SEC-02).
    const { email } = await requireAuthorizedUser(req);

    // Validacao server-side (zod): usuario/senha nao-vazios.
    // Falha de schema -> 422 antes de qualquer I/O (SEC-03).
    const { username, password } = await parseJsonBody(req, effectiPainelCredSchema, {
      validationStatus: 422,
    });

    // Resolve a fonte Effecti (404 quando inexistente).
    const fonteRecord = await getFonteByTipo("effecti");

    // Grava CIFRADO no Vault ANTES de marcar a flag: se a tabela falhar, no
    // maximo o segredo fica presente sem a flag; nunca o inverso (flag sem
    // segredo). O segredo nunca volta ao cliente (RNF-02).
    const ok = await setServiceSecret(
      EFFECTI_PAINEL_CRED_KEY_NAME,
      JSON.stringify({ username, password }),
    );

    // Marca a presenca da credencial do painel na fonte Effecti.
    const service = createServiceClient();
    const { error: updErr } = await service
      .from("fontes")
      .update({ painel_cred_em: new Date().toISOString() })
      .eq("id", fonteRecord.id);
    if (updErr) {
      throw new HttpError(
        500,
        "fonte_update_failed",
        "falha ao registrar a credencial do painel",
      );
    }

    // Auditoria SEM o segredo: registra apenas a fonte e que a credencial foi
    // atualizada (RNF-02/SEC-01).
    await logSensitiveAction({
      tabela: "fontes",
      acao: "set_painel_cred",
      registroId: fonteRecord.id,
      usuario: email,
      dadosNovos: { fonte: fonteRecord.tipo, painelCredAtualizada: ok },
    });

    return jsonResponse({ ok }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "effecti-painel-cred" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
