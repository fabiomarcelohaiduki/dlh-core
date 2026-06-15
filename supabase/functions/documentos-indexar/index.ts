// =====================================================================
// Edge Function: documentos-indexar  ->  POST /documentos-indexar
// BACKFILL da INDEXACAO (embeddings) dos documentos ja extraidos.
//
//   A indexacao CONTINUA roda inline no documentos-ingerir (no momento do
//   push do runner). Este Edge cobre o ACERVO PARADO: documentos com texto
//   gravado mas status_indexacao='pendente' (ligar embeddings depois da
//   extracao em massa). Reusa o MESMO motor agnostico
//   (generateAndStoreMemoriaChunks, origem='documento', memoria_chunks).
//
//   GOVERNANCA (config_indexacao, administravel pelo cockpit, sem hardcode):
//     ativo               master switch; OFF => nao faz nada (nem encadeia).
//     fontes_habilitadas  null=todas; array=so estas fontes (gating por
//                         documento_vinculos.fonte, controle de custo).
//     lote_chunks         ORCAMENTO por invocacao (proxy: ~2000 chars/chunk).
//     pausa_ms            pausa entre documentos (alivia a OpenAI).
//
//   AUTO-ENCADEAMENTO (mesmo padrao da coleta Effecti): processa 1 lote
//   limitado pelo orcamento (teto de wall-clock do Edge) e, se ainda ha
//   pendentes, chama reenfileirar_indexacao() (net.http_post via pg_net,
//   fire-and-forget pelo banco) -> o proximo lote dispara sozinho ate
//   esgotar a fila. claim_documentos_indexacao reivindica atomicamente
//   (marca em_andamento no mesmo comando) -> sem corrida entre lotes.
//
//   A chave da OpenAI NAO vive aqui: lida do Vault (LLM_OPENAI_API_KEY,
//   reusada da config de IA) e injetada no provider em runtime.
//
//   - Autentica por chamada interna: Bearer service_role OU X-Cron-Secret.
//   - Falha isolada por documento NAO derruba o lote: vira status='erro'.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, matchesCronSecret } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { generateAndStoreMemoriaChunks } from "../_shared/embeddings.ts";
import {
  CHARS_POR_CHUNK,
  loadConfigIndexacao,
  resolveEmbeddingProvider,
} from "../_shared/indexacao.ts";

/** Documento reivindicado para indexar (ja marcado em_andamento pelo claim). */
interface DocClaim {
  id: string;
  tipo_documento: string | null;
  texto: string;
}

// ---------------------------------------------------------------------
// Autenticacao da chamada interna (service_role OU X-Cron-Secret no Vault)
// ---------------------------------------------------------------------

async function assertInternalAuth(req: Request): Promise<void> {
  const bearer = extractBearerToken(req);
  const env = getEnv();
  if (bearer && timingSafeEqual(bearer, env.serviceRoleKey)) return;
  if (await matchesCronSecret(req)) return;
  throw new HttpError(401, "cron_unauthorized", "chamada interna nao autorizada");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    await assertInternalAuth(req);

    const service = createServiceClient();

    // Master switch + gating. OFF => nao faz nada (nao encadeia).
    const config = await loadConfigIndexacao(service);
    if (!config || !config.ativo) {
      return jsonResponse({ estado: "inativo", processados: 0 }, 200);
    }

    // Provider ANTES do claim: se a chave faltar, nada e reivindicado.
    const provider = await resolveEmbeddingProvider();

    const fontes = config.fontesHabilitadas;
    const maxChars = config.loteChunks * CHARS_POR_CHUNK;

    // Reivindica atomicamente o lote (marca em_andamento), por fonte + orcamento.
    const { data: claimed, error: claimErr } = await service.rpc("claim_documentos_indexacao", {
      p_fontes: fontes,
      p_max_chars: maxChars,
    });
    if (claimErr) {
      throw new HttpError(500, "claim_failed", "falha ao reivindicar documentos para indexar");
    }
    const docs = (Array.isArray(claimed) ? claimed : []) as DocClaim[];

    if (docs.length === 0) {
      return jsonResponse({ estado: "ocioso", processados: 0, indexados: 0, erros: 0, chunks: 0 }, 200);
    }

    let indexados = 0;
    let erros = 0;
    let chunksTotais = 0;

    for (let i = 0; i < docs.length; i += 1) {
      const doc = docs[i];
      try {
        const { chunks } = await generateAndStoreMemoriaChunks(service, {
          origem: "documento",
          tipo: doc.tipo_documento ?? null,
          registroId: doc.id,
          verbatim: doc.texto,
          provider,
        });
        await service
          .from("documentos")
          .update({ status_indexacao: "concluida" })
          .eq("id", doc.id);
        indexados += 1;
        chunksTotais += chunks;
      } catch (err) {
        erros += 1;
        await service
          .from("documentos")
          .update({ status_indexacao: "erro" })
          .eq("id", doc.id);
        console.error("[documentos-indexar] falha ao indexar documento", {
          documentoId: doc.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Pausa entre documentos (alivia a OpenAI), exceto apos o ultimo.
      if (config.pausaMs > 0 && i < docs.length - 1) {
        await sleep(config.pausaMs);
      }
    }

    // Ainda ha pendentes? Encadeia o proximo lote (fire-and-forget pelo banco).
    let estado: "avancou" | "concluiu" = "concluiu";
    const { data: temMais, error: temMaisErr } = await service.rpc(
      "tem_documento_pendente_indexacao",
      { p_fontes: fontes },
    );
    if (temMaisErr) {
      console.error("[documentos-indexar] falha ao checar pendentes", temMaisErr.message);
    } else if (temMais === true) {
      estado = "avancou";
      const { error: reqErr } = await service.rpc("reenfileirar_indexacao");
      if (reqErr) {
        // Nao derruba a resposta: o disparo manual/cron retoma o backfill.
        console.error("[documentos-indexar] reenfileirar_indexacao falhou", reqErr.message);
      }
    }

    return jsonResponse(
      { estado, processados: docs.length, indexados, erros, chunks: chunksTotais },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: "documentos-indexar" });
  }
}

getEnv();

Deno.serve(handler);
