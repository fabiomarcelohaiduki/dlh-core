// =====================================================================
// _shared/indexacao.ts
// Governanca compartilhada da INDEXACAO (embeddings) de documentos, usada
// pelo backfill (documentos-indexar) E pela indexacao continua inline
// (documentos-ingerir). Centraliza:
//
//   - loadConfigIndexacao(): le o singleton config_indexacao (master switch,
//     fontes habilitadas, orcamento de chunks, pausa) — administravel pelo
//     cockpit, sem hardcode.
//   - resolveEmbeddingProvider(): monta o provider lendo a chave do Vault
//     (LLM_OPENAI_API_KEY) quando o provider e 'openai'. A chave NUNCA vem de
//     .env do cliente nem volta ao browser.
//
// Manter num so lugar evita divergencia de gating entre os dois caminhos.
// =====================================================================

import { createServiceClient } from "./supabase.ts";
import { HttpError } from "./http.ts";
import { getServiceSecret, LLM_OPENAI_API_KEY_NAME } from "./vault.ts";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Caracteres por chunk (proxy do orcamento): casa com chunkText (DEFAULT_MAX_CHARS=2000). */
export const CHARS_POR_CHUNK = 2_000;

/** Parametros administraveis da indexacao (singleton config_indexacao). */
export interface ConfigIndexacao {
  /** Master switch: OFF => nao indexa (texto fica status_indexacao='pendente'). */
  ativo: boolean;
  /** Master switch da indexacao de PROCESSOS (nomus_processos.descricao). Independente de `ativo`. */
  processosAtivo: boolean;
  /** null = todas as fontes; array = somente estas (gating por documento_vinculos.fonte). */
  fontesHabilitadas: string[] | null;
  /** Orcamento de chunks por invocacao do backfill (proxy via CHARS_POR_CHUNK). */
  loteChunks: number;
  /** Pausa entre documentos no backfill (ms; alivia a OpenAI). */
  pausaMs: number;
  /** Teto de tentativas: ao atingi-lo a falha vira 'erro' definitivo (auto-retry abaixo dele). */
  tentativasMax: number;
  /** Teto de tokens/min mirado ao chamar a OpenAI (pacer por tokens; 0 = sem pacing). */
  tpmAlvo: number;
  /** Motor de embeddings: 'openai' (custo, chave no Vault) ou 'bge-m3-local' (self-hosted). */
  embeddingsProvider: string;
  /** URL do servico self-hosted (so 'bge-m3-local'); null quando 'openai'. */
  embeddingsEndpoint: string | null;
}

/**
 * Le a config_indexacao (singleton GLOBAL). Null SOMENTE quando nao ha linha
 * (nao deveria acontecer apos o seed) — o chamador trata como inativo. Um erro
 * REAL de banco propaga (HttpError 500) em vez de virar 'inativo' silencioso:
 * mascarar falha de leitura como master switch OFF esconderia o problema.
 */
export async function loadConfigIndexacao(
  service: ServiceClient,
): Promise<ConfigIndexacao | null> {
  const { data, error } = await service
    .from("config_indexacao")
    .select("ativo, processos_ativo, fontes_habilitadas, lote_chunks, pausa_ms, tentativas_max, tpm_alvo, embeddings_provider, embeddings_endpoint")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(
      500,
      "config_indexacao_erro",
      `falha ao ler config_indexacao: ${error.message}`,
    );
  }
  if (!data) return null;
  const c = data as Record<string, unknown>;
  return {
    ativo: c.ativo === true,
    processosAtivo: c.processos_ativo === true,
    fontesHabilitadas: Array.isArray(c.fontes_habilitadas)
      ? (c.fontes_habilitadas as string[])
      : null,
    loteChunks: typeof c.lote_chunks === "number" && c.lote_chunks > 0 ? c.lote_chunks : 1500,
    pausaMs: typeof c.pausa_ms === "number" && c.pausa_ms > 0 ? c.pausa_ms : 0,
    tentativasMax: typeof c.tentativas_max === "number" && c.tentativas_max > 0 ? c.tentativas_max : 3,
    tpmAlvo: typeof c.tpm_alvo === "number" && c.tpm_alvo >= 0 ? c.tpm_alvo : 800_000,
    embeddingsProvider: c.embeddings_provider === "bge-m3-local" ? "bge-m3-local" : "openai",
    embeddingsEndpoint:
      typeof c.embeddings_endpoint === "string" && c.embeddings_endpoint.trim() !== ""
        ? c.embeddings_endpoint.trim()
        : null,
  };
}

/**
 * Monta o provider de embeddings lendo a config_indexacao (administravel pelo
 * cockpit, sem hardcode). ESCRITA e LEITURA (busca semantica) chamam esta mesma
 * funcao -> ambas seguem a MESMA config no mesmo instante, nunca divergem.
 *
 *   'openai'       -> text-embedding-3-small (dim do env EMBEDDINGS_DIM, default
 *                     1024). A chave vive cifrada no Vault (LLM_OPENAI_API_KEY);
 *                     sem ela nao indexa (503).
 *   'bge-m3-local' -> servico self-hosted; exige embeddings_endpoint na config
 *                     (sem ele, 503). Sem chave (servico interno).
 *
 * Sem linha de config (improvavel apos o seed) cai em 'openai' = preserva o
 * comportamento legado. ATENCAO (recall): trocar o provider muda o ESPACO
 * VETORIAL; os chunks ja gravados ficam incompativeis com a busca ate o acervo
 * ser reindexado (o cockpit avisa; nao ha reindex automatico aqui).
 */
export async function resolveEmbeddingProvider(): Promise<EmbeddingProvider> {
  const service = createServiceClient();
  const config = await loadConfigIndexacao(service);
  const provider = config?.embeddingsProvider ?? "openai";

  if (provider === "bge-m3-local") {
    const endpoint = config?.embeddingsEndpoint;
    if (!endpoint) {
      throw new HttpError(
        503,
        "embeddings_endpoint_ausente",
        "indexacao 'bge-m3-local' requer embeddings_endpoint na config_indexacao, ausente",
      );
    }
    return createEmbeddingProvider({ provider: "bge-m3-local", endpoint });
  }

  const apiKey = await getServiceSecret(LLM_OPENAI_API_KEY_NAME);
  if (!apiKey) {
    throw new HttpError(
      503,
      "embeddings_key_ausente",
      "indexacao 'openai' requer LLM_OPENAI_API_KEY no Vault, ausente",
    );
  }
  return createEmbeddingProvider({ provider: "openai", apiKey });
}
