// =====================================================================
// Edge Function: indexacao  ->  /indexacao  (cockpit)
// Painel de controle da INDEXACAO (embeddings) dos documentos. Tres bocas
// numa so funcao (espelha o padrao documentos-descobrir):
//
//   PUT  -> salva a config_indexacao (singleton GLOBAL): master switch
//           `ativo`, allowlist `fontesHabilitadas`, orcamento `loteChunks`,
//           `pausaMs`. Exige sessao autorizada + audit. Vale na PROXIMA
//           invocacao do backfill e no proximo push do continuo.
//
//   POST { action:"resumo", fontes? } -> contagem por status_indexacao da(s)
//           fonte(s) (RPC resumo_indexacao, service_role). Foto da fila para
//           o painel (pendente/em_andamento/concluida/erro). Conta DOCUMENTOS.
//
//   POST { action:"resumo_avisos" } -> contagem dos AVISOS (licitacoes Effecti)
//           por status_indexacao (RPC resumo_indexacao_avisos, service_role).
//           Tabela SEPARADA de documentos; surfa o ponto cego que escondia
//           avisos travados em 'pendente'. avisos usam 'indexado' (mapeado
//           para o bucket concluida/Indexados do painel).
//
//   POST { action:"disparar" } -> aciona 1 lote de backfill AGORA: chama
//           reenfileirar_indexacao() (net.http_post no documentos-indexar,
//           fire-and-forget pelo banco), que se auto-encadeia ate esgotar a
//           fila. Exige sessao autorizada + audit. ACAO QUE GASTA: so tem
//           efeito quando `ativo=true` (o proprio documentos-indexar checa o
//           master switch; OFF => no-op).
//
//   POST { action:"reprocessar_erros", fontes? } -> move os docs em
//           status_indexacao=erro de volta para pendente (RPC
//           reenfileirar_erros_indexacao, filtrado por fonte) e reabre o
//           backfill. Retry idempotente (chunks inseridos atomicamente).
//           Exige sessao autorizada + audit. So gasta quando ativo=true.
//
//   O cockpit NAO chama documentos-indexar direto: aquele Edge so aceita
//   service_role/X-Cron-Secret (chamada interna). Esta funcao e a ponte com
//   sessao de usuario -> service_role.
//
//   A LEITURA da config e hidratada server-side (RLS) na pagina Indexacao;
//   nao ha GET aqui (evita superficie sem checagem de allowlist).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  FONTES_EXTRACAO,
  indexacaoConfigSchema,
  parseJsonBody,
} from "../_shared/validation.ts";
import { z } from "zod";

// ---------------------------------------------------------------------
// PUT — salva a config_indexacao (singleton).
// ---------------------------------------------------------------------
async function handlePut(req: Request): Promise<Response> {
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, indexacaoConfigSchema);

  const payload = {
    ativo: input.ativo,
    processos_ativo: input.processosAtivo,
    fontes_habilitadas:
      input.fontesHabilitadas && input.fontesHabilitadas.length > 0
        ? input.fontesHabilitadas
        : null,
    lote_chunks: input.loteChunks,
    pausa_ms: input.pausaMs,
    tpm_alvo: input.tpmAlvo,
    tentativas_max: input.tentativasMax,
    embeddings_provider: input.embeddingsProvider,
    // openai ignora endpoint: zera para nao deixar URL orfa de uma troca anterior.
    embeddings_endpoint:
      input.embeddingsProvider === "bge-m3-local" ? input.embeddingsEndpoint ?? null : null,
    updated_at: new Date().toISOString(),
  };

  const { data: existing, error: selErr } = await db
    .from("config_indexacao")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "indexacao_config_query_failed", "falha ao consultar a config de indexacao");
  }

  if (existing?.id) {
    const { error: updErr } = await db
      .from("config_indexacao")
      .update(payload)
      .eq("id", (existing as { id: string }).id);
    if (updErr) {
      throw new HttpError(500, "indexacao_config_update_failed", "falha ao salvar a config de indexacao");
    }
  } else {
    const { error: insErr } = await db.from("config_indexacao").insert(payload);
    if (insErr) {
      throw new HttpError(500, "indexacao_config_insert_failed", "falha ao criar a config de indexacao");
    }
  }

  await logSensitiveAction({
    tabela: "config_indexacao",
    acao: "salvar_config_indexacao",
    registroId: existing?.id ?? null,
    usuario: email,
    dadosNovos: {
      ativo: input.ativo,
      processosAtivo: input.processosAtivo,
      fontesHabilitadas: payload.fontes_habilitadas,
      loteChunks: input.loteChunks,
      pausaMs: input.pausaMs,
      tpmAlvo: input.tpmAlvo,
      tentativasMax: input.tentativasMax,
      embeddingsProvider: input.embeddingsProvider,
      embeddingsEndpoint: payload.embeddings_endpoint,
    },
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// POST { action } — resumo (contagens) ou disparar (backfill).
// ---------------------------------------------------------------------
const acaoSchema = z
  .object({
    action: z.enum(["resumo", "resumo_avisos", "disparar", "reprocessar_erros"], {
      errorMap: () => ({ message: "action invalida (use: resumo, resumo_avisos, disparar, reprocessar_erros)" }),
    }),
    fontes: z
      .array(
        z.enum(FONTES_EXTRACAO, {
          errorMap: () => ({ message: `fonte invalida (use: ${FONTES_EXTRACAO.join(", ")})` }),
        }),
      )
      .transform((items) => Array.from(new Set(items)))
      .nullable()
      .optional(),
  })
  .strict();

interface ResumoRow {
  status: string | null;
  total: number | null;
}

async function handlePost(req: Request): Promise<Response> {
  // Autorizacao primeiro (SEC-02), inclusive para contagem (substrato).
  const { email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, acaoSchema);
  const service = createServiceClient();

  if (input.action === "resumo") {
    const fontes = input.fontes && input.fontes.length > 0 ? input.fontes : null;
    const { data, error } = await service.rpc("resumo_indexacao", { p_fontes: fontes });
    if (error) {
      throw new HttpError(500, "indexacao_resumo_failed", "falha ao apurar o resumo de indexacao");
    }
    const rows = (Array.isArray(data) ? data : []) as ResumoRow[];
    const contagens = { pendente: 0, em_andamento: 0, concluida: 0, erro: 0, total: 0 };
    for (const r of rows) {
      const n = typeof r.total === "number" ? r.total : 0;
      contagens.total += n;
      if (r.status === "pendente") contagens.pendente += n;
      else if (r.status === "em_andamento") contagens.em_andamento += n;
      else if (r.status === "concluida") contagens.concluida += n;
      else if (r.status === "erro") contagens.erro += n;
    }
    return jsonResponse({ contagens }, 200);
  }

  if (input.action === "resumo_avisos") {
    // Foto da fila dos AVISOS (licitacoes Effecti) — tabela separada de
    // documentos, ciclo de indexacao proprio (aviso_chunks). Surfa o ponto
    // cego que escondia avisos travados em 'pendente'. Avisos usam o status
    // 'indexado' (nao 'concluida'): mapeado para o mesmo bucket do painel.
    const { data, error } = await service.rpc("resumo_indexacao_avisos");
    if (error) {
      throw new HttpError(500, "indexacao_resumo_avisos_failed", "falha ao apurar o resumo de indexacao dos avisos");
    }
    const rows = (Array.isArray(data) ? data : []) as ResumoRow[];
    const contagens = { pendente: 0, em_andamento: 0, concluida: 0, erro: 0, total: 0 };
    for (const r of rows) {
      const n = typeof r.total === "number" ? r.total : 0;
      contagens.total += n;
      if (r.status === "pendente") contagens.pendente += n;
      else if (r.status === "em_andamento") contagens.em_andamento += n;
      else if (r.status === "indexado" || r.status === "concluida") contagens.concluida += n;
      else if (r.status === "erro") contagens.erro += n;
    }
    return jsonResponse({ contagens }, 200);
  }

  if (input.action === "reprocessar_erros") {
    // Move os docs em status_indexacao=erro de volta para pendente (filtrado
    // por fonte) e reabre o backfill. Retry idempotente (chunks atomicos).
    const fontes = input.fontes && input.fontes.length > 0 ? input.fontes : null;
    const { data, error } = await service.rpc("reenfileirar_erros_indexacao", {
      p_fontes: fontes,
    });
    if (error) {
      throw new HttpError(502, "indexacao_reprocessar_erros_failed", "falha ao reprocessar os erros de indexacao");
    }
    const reenfileirados = typeof data === "number" ? data : 0;

    await logSensitiveAction({
      tabela: "config_indexacao",
      acao: "reprocessar_erros_indexacao",
      registroId: null,
      usuario: email,
      dadosNovos: { fontes, reenfileirados },
    });

    // 202 Accepted: o backfill roda assincrono. Se o master switch estiver
    // OFF, os docs ficam pendentes (sem gasto) ate ligar.
    return jsonResponse({ ok: true, reenfileirados }, 202);
  }

  // action === "disparar": aciona 1 lote de backfill (auto-encadeado).
  const { error } = await service.rpc("reenfileirar_indexacao");
  if (error) {
    throw new HttpError(502, "indexacao_dispatch_failed", "falha ao acionar a indexacao");
  }

  await logSensitiveAction({
    tabela: "config_indexacao",
    acao: "disparar_indexacao",
    registroId: null,
    usuario: email,
    dadosNovos: { acao: "backfill" },
  });

  // 202 Accepted: o backfill roda assincrono (Edge documentos-indexar). Se o
  // master switch estiver OFF, o documentos-indexar responde no-op (nao gasta).
  return jsonResponse({ ok: true }, 202);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    if (req.method === "PUT") return await handlePut(req);
    if (req.method === "POST") return await handlePost(req);
    throw new HttpError(405, "method_not_allowed", "use PUT (config) ou POST (resumo/disparar)");
  } catch (err) {
    return await errorResponse(err, { fn: "indexacao" });
  }
}

getEnv();

Deno.serve(handler);
