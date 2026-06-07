// =====================================================================
// Edge Function: fontes-credencial  ->  PUT /fontes-credencial
// Grava a chave de integracao da fonte no Supabase Vault (US-03/US-07,
// RNF-02). Parametrizado por fonte (effecti|nomus) — RF-11/US-03.
//
//   - Autoriza a sessao (requireAuthorizedUser) ANTES de ler o corpo (SEC-02):
//     sem sessao -> 401.
//   - Valida o corpo com zod (SEC-03): fonte enum {effecti,nomus} e token
//     string nao-vazia. Valor fora dos limites -> 422 SEM nenhum I/O externo.
//   - Grava no Vault via set_fonte_secret (SECURITY DEFINER) e atualiza
//     fontes.token_cifrado com APENAS a referencia; o segredo/header Basic
//     NUNCA volta ao cliente nem vai para log (SEC-01/RNF-02).
//   - Responde { ok, fonte, estado_conexao } e audita a acao sem segredo.
//   - Fonte inexistente -> 404 (getFonteByTipo).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { fonteCredentialSchema, parseJsonBody } from "../_shared/validation.ts";
import { getFonteByTipo, setFonteSecret } from "../_shared/vault.ts";
import type { SalvarCredencialResult } from "../_shared/types.ts";

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "PUT");

    // Autorizacao primeiro: nao processa corpo sem sessao valida (SEC-02).
    const { email } = await requireAuthorizedUser(req);

    // Validacao server-side (zod): fonte na allowlist + token nao-vazio.
    // Falha de schema -> 422 antes de qualquer I/O (SEC-03).
    const { fonte, token } = await parseJsonBody(req, fonteCredentialSchema, {
      validationStatus: 422,
    });

    // Resolve a fonte (404 quando inexistente).
    const fonteRecord = await getFonteByTipo(fonte);
    const ok = await setFonteSecret(fonteRecord.id, token);

    // Auditoria SEM o segredo: registra apenas a referencia/fonte (RNF-02/SEC-01).
    await logSensitiveAction({
      tabela: "fontes",
      acao: "set_credencial",
      registroId: fonteRecord.id,
      usuario: email,
      dadosNovos: { fonte: fonteRecord.tipo, credencialAtualizada: ok },
    });

    const body: SalvarCredencialResult = {
      ok,
      fonte: fonteRecord.tipo,
      estado_conexao: fonteRecord.estadoConexao,
    };
    return jsonResponse(body, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "fontes-credencial" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
