// =====================================================================
// Edge Function: ingestao-config  ->  GET/PUT /ingestao-config
// Le e grava config_ingestao da fonte (US-03/US-04/US-05/US-20).
// Parametrizado por fonte (effecti|nomus) — governa coleta manual e
// agendada sem redeploy (o pg_cron le a config em tempo de execucao).
//
//   - GET ?fonte=nomus  -> { fonte, janela_dias, data_inicial, recursos }.
//   - PUT { fonte, janela_dias, data_inicial?, recursos? } (+ filtros legados
//     do Effecti): valida fonte enum e chaves de recursos contra a allowlist
//     {processos,cobranca,propostas,pedidos,nfes,contas_a_receber}; valor
//     desconhecido -> 422 sem I/O (SEC-03).
//   - recursos persiste ativo/tipos_ativos/usa_filtro_data_alteracao por
//     recurso (merge preserva campos nao enviados, ex.: etapas_terminais).
//   - data_inicial e aceita no corpo mas NAO exposta na UI nesta entrega;
//     quando preenchida sobrepoe janela_dias na coleta.
//   - Exige sessao autorizada (SEC-02) em ambos os metodos e audita o toggle.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  ingestaoConfigUpsertSchema,
  parseFonteParam,
  parseJsonBody,
} from "../_shared/validation.ts";
import { getFonteByTipo } from "../_shared/vault.ts";
import type { IngestaoConfigResult, SalvarConfigResponse } from "../_shared/types.ts";

/**
 * Merge raso por recurso: para cada recurso enviado, sobrepoe os campos
 * presentes ao registro existente, preservando os demais (ex.: etapas_terminais
 * nao some num toggle de ativo/tipos). Recursos nao enviados ficam intactos.
 */
function mergeRecursos(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || typeof value !== "object") continue;
    const prev = merged[key] && typeof merged[key] === "object"
      ? (merged[key] as Record<string, unknown>)
      : {};
    merged[key] = { ...prev, ...(value as Record<string, unknown>) };
  }
  return merged;
}

async function handleGet(req: Request): Promise<Response> {
  // Sessao autorizada primeiro (SEC-02); leitura via db do usuario (RLS).
  const { db } = await requireAuthorizedUser(req);

  const url = new URL(req.url);
  const fonte = parseFonteParam(url.searchParams.get("fonte"));
  const fonteRecord = await getFonteByTipo(fonte);

  const { data, error } = await db
    .from("config_ingestao")
    .select("janela_dias, data_inicial, recursos")
    .eq("fonte_id", fonteRecord.id)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar a config de ingestao");
  }

  const body: IngestaoConfigResult = {
    fonte: fonteRecord.tipo,
    janela_dias: data?.janela_dias ?? null,
    data_inicial: data?.data_inicial ?? null,
    recursos: (data?.recursos as Record<string, unknown> | null) ?? {},
  };
  return jsonResponse(body, 200);
}

async function handlePut(req: Request): Promise<Response> {
  // Sessao autorizada primeiro (SEC-02); db carrega o JWT (RLS + audit trigger).
  const { db, email } = await requireAuthorizedUser(req);

  // Validacao por enum/allowlist antes de qualquer I/O (SEC-03) -> 422.
  const input = await parseJsonBody(req, ingestaoConfigUpsertSchema, { validationStatus: 422 });
  const fonteRecord = await getFonteByTipo(input.fonte);

  // Carrega a config atual (id + recursos) para upsert + merge de recursos.
  const { data: existing, error: selError } = await db
    .from("config_ingestao")
    .select("id, recursos")
    .eq("fonte_id", fonteRecord.id)
    .maybeSingle();

  if (selError) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar a config de ingestao");
  }

  // janela_dias (snake) tem prioridade; janelaDias (camel) e alias legado.
  const janelaDias = input.janela_dias ?? input.janelaDias;

  const payload: Record<string, unknown> = { fonte_id: fonteRecord.id };
  if (janelaDias !== undefined) payload.janela_dias = janelaDias;
  // data_inicial: aceita no corpo; null limpa, valor sobrepoe janela na coleta.
  if (input.data_inicial !== undefined) payload.data_inicial = input.data_inicial;
  if (input.frequencia !== undefined) payload.frequencia = input.frequencia;
  if (input.modalidades !== undefined) payload.modalidades = input.modalidades;
  if (input.portais !== undefined) payload.portais = input.portais;

  let recursosMerged: Record<string, unknown> | undefined;
  if (input.recursos !== undefined) {
    const base = (existing?.recursos as Record<string, unknown> | null) ?? {};
    recursosMerged = mergeRecursos(base, input.recursos as Record<string, unknown>);
    payload.recursos = recursosMerged;
  }

  if (existing?.id) {
    const { error: updError } = await db
      .from("config_ingestao")
      .update(payload)
      .eq("id", existing.id);
    if (updError) {
      throw new HttpError(500, "config_update_failed", "falha ao atualizar a config de ingestao");
    }
  } else {
    const { error: insError } = await db.from("config_ingestao").insert(payload);
    if (insError) {
      throw new HttpError(500, "config_insert_failed", "falha ao criar a config de ingestao");
    }
  }

  // Auditoria do toggle de recursos/tipos e dos demais campos (sem segredo).
  await logSensitiveAction({
    tabela: "config_ingestao",
    acao: "salvar_config",
    registroId: existing?.id ?? null,
    usuario: email,
    dadosNovos: {
      fonte: fonteRecord.tipo,
      janelaDias: janelaDias ?? null,
      dataInicial: input.data_inicial ?? null,
      recursos: recursosMerged ?? null,
      modalidades: input.modalidades ?? null,
      portais: input.portais ?? null,
    },
  });

  const body: SalvarConfigResponse = { ok: true };
  return jsonResponse(body, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    if (req.method === "GET") return await handleGet(req);
    if (req.method === "PUT") return await handlePut(req);
    throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou PUT");
  } catch (err) {
    return await errorResponse(err, { fn: "ingestao-config" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
