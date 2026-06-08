// =====================================================================
// Edge Function: extracao-config  ->  PUT /extracao-config
// Persiste os PARAMETROS da camada 1 do extrator (singleton GLOBAL
// config_extracao). O runner Node (.github/scripts/extrator.mjs) le esta
// config no inicio do job; administrar aqui = zero hardcode, sem redeploy.
//
//   PUT  -> valida e persiste { ocrEstrategia, ocrIdioma, tamanhoMaxBytes,
//           timeoutMs, extensoesHabilitadas, loteTamanho, pausaLoteMs }.
//           Exige sessao autorizada + audit. Vale na PROXIMA execucao.
//
//   A LEITURA e hidratada server-side (RLS) na pagina Fontes via createClient
//   — nao ha GET aqui (evita superficie sem checagem de allowlist).
//
//   Singleton: ha 1 linha (seed na migration). O PUT atualiza essa linha;
//   cria se (por algum motivo) nao existir. Contrato camelCase no body;
//   mapeia para snake_case da tabela.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { extracaoConfigSchema, parseJsonBody } from "../_shared/validation.ts";

async function handlePut(req: Request): Promise<Response> {
  // Sessao autorizada (RLS + audit trail).
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, extracaoConfigSchema);

  const payload = {
    ocr_estrategia: input.ocrEstrategia,
    ocr_idioma: input.ocrIdioma,
    tamanho_max_bytes: input.tamanhoMaxBytes,
    timeout_ms: input.timeoutMs,
    extensoes_habilitadas:
      input.extensoesHabilitadas && input.extensoesHabilitadas.length > 0
        ? input.extensoesHabilitadas
        : null,
    lote_tamanho: input.loteTamanho,
    pausa_lote_ms: input.pausaLoteMs,
    updated_at: new Date().toISOString(),
  };

  // Singleton: atualiza a unica linha; cria se (por algum motivo) nao existir.
  const { data: existing, error: selErr } = await db
    .from("config_extracao")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "extracao_config_query_failed", "falha ao consultar a config de extracao");
  }

  if (existing?.id) {
    const { error: updErr } = await db
      .from("config_extracao")
      .update(payload)
      .eq("id", (existing as { id: string }).id);
    if (updErr) {
      throw new HttpError(500, "extracao_config_update_failed", "falha ao salvar a config de extracao");
    }
  } else {
    const { error: insErr } = await db.from("config_extracao").insert(payload);
    if (insErr) {
      throw new HttpError(500, "extracao_config_insert_failed", "falha ao criar a config de extracao");
    }
  }

  await logSensitiveAction({
    tabela: "config_extracao",
    acao: "salvar_config_extracao",
    registroId: existing?.id ?? null,
    usuario: email,
    dadosNovos: {
      ocrEstrategia: input.ocrEstrategia,
      ocrIdioma: input.ocrIdioma,
      tamanhoMaxBytes: input.tamanhoMaxBytes,
      timeoutMs: input.timeoutMs,
      extensoesHabilitadas: payload.extensoes_habilitadas,
      loteTamanho: input.loteTamanho,
      pausaLoteMs: input.pausaLoteMs,
    },
  });

  return jsonResponse({ ok: true }, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    if (req.method === "PUT") return await handlePut(req);
    throw new HttpError(405, "method_not_allowed", "use PUT");
  } catch (err) {
    return await errorResponse(err, { fn: "extracao-config" });
  }
}

getEnv();

Deno.serve(handler);
