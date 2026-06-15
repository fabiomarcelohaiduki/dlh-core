// =====================================================================
// Edge Function: config-llm  ->  /config-llm
// Le e persiste a configuracao da IA (LLM) usada nas geracoes assistidas
// do cockpit (ex: descricao comercial de produto). Singleton config_llm.
//
//   GET  -> { provider, modelo, ativo, key_configurada }. NUNCA devolve a
//           chave; key_configurada apenas sinaliza se ha segredo no Vault.
//   PUT  -> valida (zod) e persiste provider/modelo/ativo. Se apiKey vier
//           no corpo, grava CIFRADA no Vault (set_service_secret) e NAO a
//           devolve; ausente preserva a chave ja gravada. Exige sessao
//           autorizada + audit SEM o segredo.
//
//   A chave NUNCA fica na tabela nem volta ao cliente (alinhado ao padrao
//   de fontes-credencial / RNF-02). Administravel pelo cockpit, sem hardcode.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { configLlmSchema, parseJsonBody } from "../_shared/validation.ts";
import {
  getServiceSecret,
  LLM_OPENAI_API_KEY_NAME,
  setServiceSecret,
} from "../_shared/vault.ts";

interface ConfigLlmRow {
  id: string;
  provider: string;
  modelo: string;
  ativo: boolean;
  descricao_max_palavras: number;
}

const SELECT_COLS = "id, provider, modelo, ativo, descricao_max_palavras";

/** Default de palavras quando a config ainda nao foi salva. */
const DESCRICAO_MAX_PALAVRAS_DEFAULT = 40;

async function handleGet(): Promise<Response> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("config_llm")
    .select(SELECT_COLS)
    .order("id")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_llm_query_failed", "falha ao consultar a config da IA");
  }

  const row = data as ConfigLlmRow | null;
  const segredo = await getServiceSecret(LLM_OPENAI_API_KEY_NAME);

  return jsonResponse(
    {
      provider: row?.provider ?? "openai",
      modelo: row?.modelo ?? "gpt-4o-mini",
      ativo: row?.ativo ?? false,
      descricaoMaxPalavras: row?.descricao_max_palavras ?? DESCRICAO_MAX_PALAVRAS_DEFAULT,
      key_configurada: segredo != null,
    },
    200,
  );
}

async function handlePut(req: Request): Promise<Response> {
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, configLlmSchema);

  // Invariante DETERMINISTICA no backend (nao so na UI): IA ativa exige chave.
  // Vale para a chave que chega no corpo OU para a que ja esta no Vault.
  const chaveJaConfigurada = (await getServiceSecret(LLM_OPENAI_API_KEY_NAME)) != null;
  const chaveNoCorpo = typeof input.apiKey === "string" && input.apiKey.trim() !== "";
  if (input.ativo && !chaveNoCorpo && !chaveJaConfigurada) {
    throw new HttpError(
      400,
      "chave_obrigatoria",
      "ative a IA somente com uma chave configurada",
    );
  }

  // Chave opcional: grava CIFRADA no Vault ANTES de marcar a config (nunca
  // volta ao cliente). Assim, se a tabela falhar, no maximo a chave fica
  // presente sem a config ativa; nunca o inverso (ativo sem chave).
  let keyAtualizada = false;
  if (chaveNoCorpo) {
    await setServiceSecret(LLM_OPENAI_API_KEY_NAME, input.apiKey!.trim());
    keyAtualizada = true;
  }

  const payload = {
    provider: input.provider,
    modelo: input.modelo,
    ativo: input.ativo,
    descricao_max_palavras: input.descricaoMaxPalavras,
    updated_at: new Date().toISOString(),
  };

  // Singleton: atualiza a unica linha; cria se (por algum motivo) nao existir.
  const { data: existing, error: selErr } = await db
    .from("config_llm")
    .select("id")
    .order("id")
    .limit(1)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "config_llm_query_failed", "falha ao consultar a config da IA");
  }

  if (existing?.id) {
    const { error: updErr } = await db
      .from("config_llm")
      .update(payload)
      .eq("id", (existing as { id: string }).id);
    if (updErr) {
      throw new HttpError(500, "config_llm_update_failed", "falha ao salvar a config da IA");
    }
  } else {
    const { error: insErr } = await db.from("config_llm").insert(payload);
    if (insErr) {
      throw new HttpError(500, "config_llm_insert_failed", "falha ao criar a config da IA");
    }
  }

  const keyConfigurada = chaveJaConfigurada || keyAtualizada;

  // Audit SEM o segredo: registra apenas se a chave foi atualizada.
  await logSensitiveAction({
    tabela: "config_llm",
    acao: "salvar_config_llm",
    registroId: existing?.id ?? null,
    usuario: email,
    dadosNovos: {
      provider: payload.provider,
      modelo: payload.modelo,
      ativo: payload.ativo,
      descricaoMaxPalavras: payload.descricao_max_palavras,
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
    return await errorResponse(err, { fn: "config-llm" });
  }
}

getEnv();

Deno.serve(handler);
