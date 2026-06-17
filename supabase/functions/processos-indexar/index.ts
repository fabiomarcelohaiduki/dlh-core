// =====================================================================
// Edge Function: processos-indexar  ->  POST /processos-indexar
// BACKFILL da INDEXACAO (embeddings) dos PROCESSOS do Nomus.
//
//   Espelha documentos-indexar para a perna de PROCESSOS: indexa
//   nomus_processos.descricao em memoria_chunks com origem='processo',
//   reusando o MESMO motor agnostico (generateAndStoreMemoriaChunksSlice).
//   A descricao e HTML -> stripHtml roda AQUI (ponto unico) antes de
//   chunkar/embeddar; o verbatim indexado e o texto puro.
//
//   GOVERNANCA: reusa o singleton config_indexacao. O master switch desta
//   perna e `processos_ativo` (independente de `ativo`, que governa os
//   documentos). Orcamento (lote_chunks), pausa (pausa_ms), teto de
//   tentativas (tentativas_max) e o pacer por TPM (tpm_alvo) sao
//   COMPARTILHADOS com a perna de documentos.
//
//   LOCK GLOBAL COMPARTILHADO (try_lock_indexacao / unlock_indexacao):
//   documentos e processos NUNCA rodam em paralelo -> o teto de TPM da
//   OpenAI nunca e dobrado (evita o storm de 429). Se a perna de documentos
//   estiver processando, esta invocacao retorna "ocupado" e o cron
//   processos-kick a religa depois.
//
//   AUTO-ENCADEAMENTO via reenfileirar_indexacao_processos() (pg_net),
//   mesmo padrao dos documentos: processa 1 lote limitado pelo orcamento e,
//   se ainda ha pendentes, encadeia o proximo ate esgotar a fila.
//
//   - Autentica por chamada interna: Bearer service_role OU X-Cron-Secret.
//   - Falha isolada por processo NAO derruba o lote: auto-retry ate o teto.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, matchesCronSecret } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { generateAndStoreMemoriaChunksSlice } from "../_shared/embeddings.ts";
import {
  CHARS_POR_CHUNK,
  loadConfigIndexacao,
  resolveEmbeddingProvider,
} from "../_shared/indexacao.ts";
import { stripHtml } from "../_shared/html.ts";

/** Processo reivindicado para indexar (ja marcado em_andamento pelo claim). */
interface ProcessoClaim {
  id: string;
  nome: string | null;
  tipo: string | null;
  etapa: string | null;
  pessoa: string | null;
  descricao: string | null;
  chunks_indexados: number | null;
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

/**
 * Pacer POR TOKENS: cada chamada `pace(tokens)` espera o necessario para que
 * a taxa de tokens enviados a OpenAI fique abaixo de `tpmAlvo` (tokens/min).
 * Serial (a indexacao roda em fluxo unico). tpmAlvo<=0 desliga o pacing.
 */
function criarPacer(tpmAlvo: number): (tokens: number) => Promise<void> {
  let proximoInicio = 0;
  return async (tokens: number): Promise<void> => {
    if (tpmAlvo <= 0 || tokens <= 0) return;
    const agora = Date.now();
    if (agora < proximoInicio) {
      await sleep(proximoInicio - agora);
    }
    const inicio = Math.max(agora, proximoInicio);
    const intervaloMs = (tokens / tpmAlvo) * 60_000;
    proximoInicio = inicio + intervaloMs;
  };
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  let service: ReturnType<typeof createServiceClient> | null = null;
  let holdsLock = false;
  // Encadeamento DEPOIS de soltar o lock (mesmo motivo dos documentos: a
  // continuacao da cadeia nunca pode bater no proprio lock e morrer).
  let deveEncadear = false;
  try {
    assertMethod(req, "POST");
    await assertInternalAuth(req);

    service = createServiceClient();

    // Master switch da perna de processos. OFF => nao faz nada (nao encadeia).
    const config = await loadConfigIndexacao(service);
    if (!config || !config.processosAtivo) {
      return jsonResponse({ estado: "inativo", processados: 0 }, 200);
    }

    // FLUXO UNICO GLOBAL: o MESMO lock dos documentos. Serializa as duas
    // pernas -> nunca dobra o TPM da OpenAI. Stale-aware (>2min). O finally
    // libera ao sair.
    const { data: lockOk, error: lockErr } = await service.rpc("try_lock_indexacao", {
      p_stale_minutes: 2,
    });
    if (lockErr) {
      throw new HttpError(500, "lock_failed", "falha ao adquirir lock de indexacao");
    }
    if (lockOk !== true) {
      return jsonResponse({ estado: "ocupado", processados: 0 }, 200);
    }
    holdsLock = true;

    const db = service;

    // Provider ANTES do claim: se a chave faltar, nada e reivindicado.
    const provider = await resolveEmbeddingProvider();

    const maxChars = config.loteChunks * CHARS_POR_CHUNK;

    // Pacer por tokens compartilhado por TODOS os processos desta invocacao.
    const pace = criarPacer(config.tpmAlvo);

    // Reivindica atomicamente o lote (marca em_andamento), por orcamento.
    const { data: claimed, error: claimErr } = await service.rpc("claim_processos_indexacao", {
      p_max_chars: maxChars,
    });
    if (claimErr) {
      throw new HttpError(500, "claim_failed", "falha ao reivindicar processos para indexar");
    }
    const procs = (Array.isArray(claimed) ? claimed : []) as ProcessoClaim[];

    if (procs.length === 0) {
      return jsonResponse({ estado: "ocioso", processados: 0, indexados: 0, erros: 0, chunks: 0 }, 200);
    }

    let indexados = 0;
    let parciais = 0;
    let erros = 0;
    let chunksTotais = 0;

    // ORCAMENTO POR CHUNKS por invocacao (igual aos documentos): processo
    // grande e fatiado a partir do checkpoint sem truncar (recall total).
    let restante = Math.max(1, config.loteChunks);

    for (let i = 0; i < procs.length; i += 1) {
      const proc = procs[i];

      // Orcamento esgotado: libera o processo reivindicado de volta a fila.
      if (restante <= 0) {
        const { error: relErr } = await service
          .from("nomus_processos")
          .update({ status_indexacao: "pendente" })
          .eq("id", proc.id);
        if (relErr) {
          console.error("[processos-indexar] falha ao liberar processo nao processado", relErr.message);
        }
        continue;
      }

      // A descricao e HTML -> strip AQUI (ponto unico) antes de chunkar.
      const verbatim = stripHtml(proc.descricao);

      // Descricao vazia apos o strip (so markup/whitespace): nada a indexar.
      // Conclui com 0 chunks (sai da fila; descricao_chars>0 mas sem texto util).
      // Apaga chunks remanescentes ANTES de concluir: no cenario de reindexacao
      // (descricao editada p/ vazia) os chunks antigos virariam orfaos.
      if (!verbatim) {
        const { error: delErr } = await service
          .from("memoria_chunks")
          .delete()
          .eq("origem", "processo")
          .eq("registro_id", proc.id);
        if (delErr) {
          console.error("[processos-indexar] falha ao limpar chunks de processo vazio", {
            processoId: proc.id,
            error: delErr.message,
          });
        }
        await service
          .from("nomus_processos")
          .update({ status_indexacao: "concluida", chunks_indexados: 0 })
          .eq("id", proc.id);
        indexados += 1;
        continue;
      }

      try {
        const resultado = await generateAndStoreMemoriaChunksSlice(service, {
          origem: "processo",
          tipo: proc.tipo ?? null,
          registroId: proc.id,
          verbatim,
          provider,
          chunkOffset: proc.chunks_indexados ?? 0,
          maxChunks: restante,
        }, {
          pace,
          onProgress: async (checkpoint) => {
            const { error } = await db
              .from("nomus_processos")
              .update({ chunks_indexados: checkpoint, tentativas_indexacao: 0 })
              .eq("id", proc.id);
            if (error) {
              console.error("[processos-indexar] falha ao gravar checkpoint", {
                processoId: proc.id,
                checkpoint,
                error: error.message,
              });
            }
          },
        });

        restante -= resultado.inseridos;
        chunksTotais += resultado.inseridos;

        if (resultado.concluido) {
          await service
            .from("nomus_processos")
            .update({ status_indexacao: "concluida", chunks_indexados: resultado.total })
            .eq("id", proc.id);
          indexados += 1;
        } else {
          await service
            .from("nomus_processos")
            .update({
              status_indexacao: "pendente",
              chunks_indexados: resultado.proximoOffset,
              tentativas_indexacao: 0,
            })
            .eq("id", proc.id);
          parciais += 1;
        }
      } catch (err) {
        erros += 1;
        // Auto-retry: incrementa tentativas e re-marca 'pendente' enquanto
        // abaixo do teto; so vira 'erro' DEFINITIVO no teto. O checkpoint
        // (chunks_indexados) e preservado -> retoma de onde parou.
        const { error: falhaErr } = await service.rpc("marcar_falha_indexacao_processo", {
          p_id: proc.id,
          p_teto: config.tentativasMax,
        });
        if (falhaErr) {
          console.error("[processos-indexar] marcar_falha_indexacao_processo falhou", falhaErr.message);
        }
        console.error("[processos-indexar] falha ao indexar processo", {
          processoId: proc.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Pausa entre processos (alivia a OpenAI), exceto apos o ultimo.
      if (config.pausaMs > 0 && i < procs.length - 1 && restante > 0) {
        await sleep(config.pausaMs);
      }
    }

    // Ainda ha pendentes? So MARCA que deve encadear; o disparo (pg_net) sai
    // no finally, DEPOIS de soltar o lock.
    let estado: "avancou" | "concluiu" = "concluiu";
    const { data: temMais, error: temMaisErr } = await service.rpc(
      "tem_processo_pendente_indexacao",
    );
    if (temMaisErr) {
      console.error("[processos-indexar] falha ao checar pendentes", temMaisErr.message);
    } else if (temMais === true) {
      estado = "avancou";
      deveEncadear = true;
    }

    return jsonResponse(
      { estado, processados: procs.length, indexados, parciais, erros, chunks: chunksTotais },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: "processos-indexar" });
  } finally {
    if (service && holdsLock) {
      const { error: unlockErr } = await service.rpc("unlock_indexacao");
      if (unlockErr) {
        console.error("[processos-indexar] unlock_indexacao falhou", unlockErr.message);
      }
      if (deveEncadear) {
        const { error: reqErr } = await service.rpc("reenfileirar_indexacao_processos");
        if (reqErr) {
          console.error("[processos-indexar] reenfileirar_indexacao_processos falhou", reqErr.message);
        }
      }
    }
  }
}

getEnv();

Deno.serve(handler);
