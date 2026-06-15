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
  /** null = todas as fontes; array = somente estas (gating por documento_vinculos.fonte). */
  fontesHabilitadas: string[] | null;
  /** Orcamento de chunks por invocacao do backfill (proxy via CHARS_POR_CHUNK). */
  loteChunks: number;
  /** Pausa entre documentos no backfill (ms; alivia a OpenAI). */
  pausaMs: number;
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
    .select("ativo, fontes_habilitadas, lote_chunks, pausa_ms")
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
    fontesHabilitadas: Array.isArray(c.fontes_habilitadas)
      ? (c.fontes_habilitadas as string[])
      : null,
    loteChunks: typeof c.lote_chunks === "number" && c.lote_chunks > 0 ? c.lote_chunks : 1500,
    pausaMs: typeof c.pausa_ms === "number" && c.pausa_ms > 0 ? c.pausa_ms : 0,
  };
}

/**
 * Monta o provider de embeddings da camada de DOCUMENTOS. Forca provider
 * 'openai' EXPLICITAMENTE (decisao 2026-06-11: text-embedding-3-small, dim
 * 1024) em vez de depender de EMBEDDINGS_PROVIDER do env: flipar o env global
 * arrastaria as demais funcoes (busca semantica, reindex) que chamam
 * createEmbeddingProvider() sem chave -> 401. Isolar aqui = blast radius zero.
 * A chave vive cifrada no Vault (LLM_OPENAI_API_KEY); sem ela nao indexa (503).
 * A dimensao vem do env (EMBEDDINGS_DIM, default 1024) e e validada no provider.
 */
export async function resolveEmbeddingProvider(): Promise<EmbeddingProvider> {
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
