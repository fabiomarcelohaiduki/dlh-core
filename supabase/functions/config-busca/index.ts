// =====================================================================
// Edge Function: config-busca  ->  /config-busca
// Le e persiste a configuracao do RERANKING da busca semantica do acervo
// (singleton config_busca). Espelha config-llm: a chave da Cohere vive no
// Vault, nunca na tabela nem no contrato.
//
//   GET  -> { rerankAtivo, rerankModelo, rerankCandidatos, key_configurada }.
//           NUNCA devolve a chave; key_configurada apenas sinaliza se ha
//           segredo no Vault (COHERE_RERANK_API_KEY).
//   PUT  -> valida (zod) e persiste rerankAtivo/rerankModelo/rerankCandidatos.
//           Se apiKey vier no corpo, grava CIFRADA no Vault e NAO a devolve;
//           ausente preserva a chave ja gravada. Exige sessao autorizada +
//           audit SEM o segredo.
//
//   FAIL-OPEN: a Edge de busca cai no vetorial puro se a chave faltar; aqui
//   a invariante DETERMINISTICA e: rerank ativo exige chave configurada.
//   Administravel pelo cockpit, sem hardcode.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { configBuscaSchema, parseJsonBody } from "../_shared/validation.ts";
import { getServiceSecret, setServiceSecret } from "../_shared/vault.ts";
import { COHERE_RERANK_API_KEY_NAME } from "../_shared/rerank.ts";

interface ConfigBuscaRow {
  id: string;
  rerank_ativo: boolean;
  rerank_modelo: string;
  rerank_candidatos: number;
}

const SELECT_COLS = "id, rerank_ativo, rerank_modelo, rerank_candidatos";

/** Defaults quando a config ainda nao foi salva (espelha o seed). */
const RERANK_MODELO_DEFAULT = "rerank-v3.5";
const RERANK_CANDIDATOS_DEFAULT = 50;

async function handleGet(): Promise<Response> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("config_busca")
    .select(SELECT_COLS)
    .order("id")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_busca_query_failed", "falha ao consultar a config de busca");
  }

  const row = data as ConfigBuscaRow | null;
  const segredo = await getServiceSecret(COHERE_RERANK_API_KEY_NAME);

  return jsonResponse(
    {
      rerankAtivo: row?.rerank_ativo ?? true,
      rerankModelo: row?.rerank_modelo ?? RERANK_MODELO_DEFAULT,
      rerankCandidatos: row?.rerank_candidatos ?? RERANK_CANDIDATOS_DEFAULT,
      key_configurada: segredo != null,
    },
    200,
  );
}

async function handlePut(req: Request): Promise<Response> {
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, configBuscaSchema);

  // Invariante DETERMINISTICA no backend (nao so na UI): rerank ativo exige
  // chave. Vale para a chave que chega no corpo OU para a que ja esta no Vault.
  const chaveJaConfigurada = (await getServiceSecret(COHERE_RERANK_API_KEY_NAME)) != null;
  const chaveNoCorpo = typeof input.apiKey === "string" && input.apiKey.trim() !== "";
  if (input.rerankAtivo && !chaveNoCorpo && !chaveJaConfigurada) {
    throw new HttpError(
      400,
      "chave_obrigatoria",
      "ative o rerank somente com uma chave configurada",
    );
  }

  // Chave opcional: grava CIFRADA no Vault ANTES de marcar a config (nunca
  // volta ao cliente). Assim, se a tabela falhar, no maximo a chave fica
  // presente sem o rerank ativo; nunca o inverso (ativo sem chave).
  let keyAtualizada = false;
  if (chaveNoCorpo) {
    await setServiceSecret(COHERE_RERANK_API_KEY_NAME, input.apiKey!.trim());
    keyAtualizada = true;
  }

  const payload = {
    rerank_ativo: input.rerankAtivo,
    rerank_modelo: input.rerankModelo,
    rerank_candidatos: input.rerankCandidatos,
    updated_at: new Date().toISOString(),
  };

  // Singleton: atualiza a unica linha; cria se (por algum motivo) nao existir.
  const { data: existing, error: selErr } = await db
    .from("config_busca")
    .select("id")
    .order("id")
    .limit(1)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "config_busca_query_failed", "falha ao consultar a config de busca");
  }

  if (existing?.id) {
    const { error: updErr } = await db
      .from("config_busca")
      .update(payload)
      .eq("id", (existing as { id: string }).id);
    if (updErr) {
      throw new HttpError(500, "config_busca_update_failed", "falha ao salvar a config de busca");
    }
  } else {
    const { error: insErr } = await db.from("config_busca").insert(payload);
    if (insErr) {
      throw new HttpError(500, "config_busca_insert_failed", "falha ao criar a config de busca");
    }
  }

  const keyConfigurada = chaveJaConfigurada || keyAtualizada;

  // Audit SEM o segredo: registra apenas se a chave foi atualizada.
  await logSensitiveAction({
    tabela: "config_busca",
    acao: "salvar_config_busca",
    registroId: existing?.id ?? null,
    usuario: email,
    dadosNovos: {
      rerankAtivo: payload.rerank_ativo,
      rerankModelo: payload.rerank_modelo,
      rerankCandidatos: payload.rerank_candidatos,
      chaveAtualizada: keyAtualizada,
    },
  });

  return jsonResponse({ ok: true, key_configurada: keyConfigurada }, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    if (req.method === "GET") return await handleGet();
    if (req.method === "PUT") return await handlePut(req);
    throw new HttpError(405, "method_not_allowed", "use GET ou PUT");
  } catch (err) {
    return await errorResponse(err, { fn: "config-busca" });
  }
}

getEnv();

Deno.serve(handler);
