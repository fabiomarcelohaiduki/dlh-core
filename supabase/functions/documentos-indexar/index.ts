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
//     tentativas_max      teto de tentativas: falha < teto volta 'pendente'
//                         (auto-retry); >= teto vira 'erro' definitivo.
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
//   - Falha isolada por documento NAO derruba o lote: incrementa tentativas
//     e volta 'pendente' (auto-retry) ate o teto -> 'erro' definitivo.
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

/** Documento reivindicado para indexar (ja marcado em_andamento pelo claim). */
interface DocClaim {
  id: string;
  tipo_documento: string | null;
  texto: string;
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
 * Cria um pacer POR TOKENS: cada chamada `pace(tokens)` espera o necessario
 * para que a taxa de tokens enviados a OpenAI fique abaixo de `tpmAlvo`
 * (tokens/min). Serial (a indexacao roda em fluxo unico), com estado de taxa
 * que atravessa todos os documentos da invocacao. tpmAlvo<=0 desliga o pacing.
 */
function criarPacer(tpmAlvo: number): (tokens: number) => Promise<void> {
  let proximoInicio = 0; // timestamp (ms) em que o proximo request pode comecar
  return async (tokens: number): Promise<void> => {
    if (tpmAlvo <= 0 || tokens <= 0) return;
    const agora = Date.now();
    if (agora < proximoInicio) {
      await sleep(proximoInicio - agora);
    }
    const inicio = Math.max(agora, proximoInicio);
    // Intervalo minimo que este lote "ocupa" da janela de 1 min na taxa alvo.
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
  // Encadeamento DEPOIS de soltar o lock: a continuacao da cadeia (pg_net)
  // so e disparada no finally, ja com o lock livre. Disparar dentro do try
  // (com o lock ainda na mao) criava a corrida que devolvia "ocupado" e
  // matava a cadeia -> backfill so andava pelo cron de seguranca.
  let deveEncadear = false;
  try {
    assertMethod(req, "POST");
    await assertInternalAuth(req);

    service = createServiceClient();

    // Master switch + gating. OFF => nao faz nada (nao encadeia).
    const config = await loadConfigIndexacao(service);
    if (!config || !config.ativo) {
      return jsonResponse({ estado: "inativo", processados: 0 }, 200);
    }

    // FLUXO UNICO: so UMA invocacao processa por vez. Sem isto, o auto-
    // encadeamento + cron + disparos manuais geram cadeias PARALELAS que
    // somam burst na OpenAI -> 429 sustentado derruba ate ~90% dos docs.
    // Stale-aware: lock vencido (>2min, invocacao morta sem liberar) e
    // retomado. O finally do handler libera o lock ao sair. 2min e margem
    // segura sobre o wall-clock de um lote pequeno (lote_chunks menor garante
    // que a invocacao termina e alcanca o finally bem antes de vencer).
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

    // Referencia nao-nula para uso dentro de closures (o `let service` perde
    // a narrowing dentro do callback onProgress).
    const db = service;

    // Provider ANTES do claim: se a chave faltar, nada e reivindicado.
    const provider = await resolveEmbeddingProvider();

    const fontes = config.fontesHabilitadas;
    const maxChars = config.loteChunks * CHARS_POR_CHUNK;

    // Pacer por tokens compartilhado por TODOS os docs desta invocacao: mantem
    // a taxa de tokens enviados a OpenAI abaixo de tpm_alvo (evita o 429 por
    // burst que derrubava documentos grandes no tier 1).
    const pace = criarPacer(config.tpmAlvo);

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
    let parciais = 0;
    let erros = 0;
    let chunksTotais = 0;

    // ORCAMENTO POR CHUNKS por invocacao: um doc enorme NAO e processado
    // inteiro (estourava o wall-clock e ficava orfao). Cada invocacao gasta
    // ate `lote_chunks` chunks no total, fatiando documentos grandes a partir
    // do checkpoint (chunks_indexados) sem NUNCA truncar o texto (recall
    // total). Quando o orcamento acaba, os docs reivindicados e nao tocados
    // voltam a 'pendente' para a proxima invocacao reivindicar.
    let restante = Math.max(1, config.loteChunks);

    for (let i = 0; i < docs.length; i += 1) {
      const doc = docs[i];

      // Orcamento esgotado: libera o doc reivindicado de volta para a fila
      // (sem queimar tentativa nem mexer no checkpoint).
      if (restante <= 0) {
        const { error: relErr } = await service
          .from("documentos")
          .update({ status_indexacao: "pendente" })
          .eq("id", doc.id);
        if (relErr) {
          console.error("[documentos-indexar] falha ao liberar doc nao processado", relErr.message);
        }
        continue;
      }

      try {
        const resultado = await generateAndStoreMemoriaChunksSlice(service, {
          origem: "documento",
          tipo: doc.tipo_documento ?? null,
          registroId: doc.id,
          verbatim: doc.texto,
          provider,
          chunkOffset: doc.chunks_indexados ?? 0,
          maxChunks: restante,
        }, {
          // Pacer POR TOKENS entre lotes (dentro e atravessando docs): mantem a
          // taxa abaixo do teto de TPM da OpenAI, eliminando o burst que
          // derrubava documentos grandes (a causa raiz dos ~28% de erro).
          pace,
          // Checkpoint DURAVEL lote-a-lote: doc enorme nunca recomeca do zero
          // se a invocacao morrer no meio (429/wall-clock). Mantem em_andamento
          // durante o progresso (orphan recovery de 15min retoma se morrer).
          onProgress: async (checkpoint) => {
            // Progresso real limpa o orcamento de falhas: um doc enorme que
            // avanca lote-a-lote (mesmo errando no fim de uma fatia) nunca
            // esgota tentativas_max -> sempre conclui (recall total).
            const { error } = await db
              .from("documentos")
              .update({ chunks_indexados: checkpoint, tentativas_indexacao: 0 })
              .eq("id", doc.id);
            if (error) {
              console.error("[documentos-indexar] falha ao gravar checkpoint", {
                documentoId: doc.id,
                checkpoint,
                error: error.message,
              });
            }
          },
        });

        restante -= resultado.inseridos;
        chunksTotais += resultado.inseridos;

        if (resultado.concluido) {
          // Doc inteiro indexado: conclui e fixa o checkpoint no total.
          await service
            .from("documentos")
            .update({
              status_indexacao: "concluida",
              chunks_indexados: resultado.total,
            })
            .eq("id", doc.id);
          indexados += 1;
        } else {
          // Progresso parcial: salva o checkpoint e devolve a 'pendente' para
          // retomar na proxima invocacao. ZERA tentativas (progresso real
          // limpa o orcamento de falhas -> doc grande nunca esgota o teto).
          await service
            .from("documentos")
            .update({
              status_indexacao: "pendente",
              chunks_indexados: resultado.proximoOffset,
              tentativas_indexacao: 0,
            })
            .eq("id", doc.id);
          parciais += 1;
        }
      } catch (err) {
        erros += 1;
        // Auto-retry: incrementa tentativas e re-marca 'pendente' enquanto
        // abaixo do teto (a cadeia drena pendente sozinha -> reprocesso
        // automatico do transitorio); so vira 'erro' DEFINITIVO no teto. O
        // checkpoint (chunks_indexados) e preservado -> retoma de onde parou.
        const { error: falhaErr } = await service.rpc("marcar_falha_indexacao", {
          p_id: doc.id,
          p_teto: config.tentativasMax,
        });
        if (falhaErr) {
          console.error("[documentos-indexar] marcar_falha_indexacao falhou", falhaErr.message);
        }
        console.error("[documentos-indexar] falha ao indexar documento", {
          documentoId: doc.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Pausa entre documentos (alivia a OpenAI), exceto apos o ultimo.
      if (config.pausaMs > 0 && i < docs.length - 1 && restante > 0) {
        await sleep(config.pausaMs);
      }
    }

    // Ainda ha pendentes? So MARCA que deve encadear; o disparo (pg_net) sai
    // no finally, DEPOIS de soltar o lock, para a continuacao nunca bater no
    // proprio lock ("ocupado") e morrer.
    let estado: "avancou" | "concluiu" = "concluiu";
    const { data: temMais, error: temMaisErr } = await service.rpc(
      "tem_documento_pendente_indexacao",
      { p_fontes: fontes },
    );
    if (temMaisErr) {
      console.error("[documentos-indexar] falha ao checar pendentes", temMaisErr.message);
    } else if (temMais === true) {
      estado = "avancou";
      deveEncadear = true;
    }

    return jsonResponse(
      { estado, processados: docs.length, indexados, parciais, erros, chunks: chunksTotais },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: "documentos-indexar" });
  } finally {
    // Libera o lock de fluxo unico ao sair (qualquer caminho). So se ESTA
    // invocacao o detem -> nunca libera o lock de outra (erros pre-lock como
    // auth/method nao chegam aqui com holdsLock=true).
    if (service && holdsLock) {
      const { error: unlockErr } = await service.rpc("unlock_indexacao");
      if (unlockErr) {
        console.error("[documentos-indexar] unlock_indexacao falhou", unlockErr.message);
      }
      // Encadeia o proximo lote SO depois de soltar o lock: a invocacao
      // seguinte encontra o lock livre e processa de verdade (em vez de cair
      // em "ocupado"). Se esta invocacao morreu por wall-clock, o finally nao
      // roda -> o cron-heartbeat (1min) religa a cadeia. Fire-and-forget.
      if (deveEncadear) {
        const { error: reqErr } = await service.rpc("reenfileirar_indexacao");
        if (reqErr) {
          console.error("[documentos-indexar] reenfileirar_indexacao falhou", reqErr.message);
        }
      }
    }
  }
}

getEnv();

Deno.serve(handler);
