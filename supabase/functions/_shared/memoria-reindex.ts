// =====================================================================
// _shared/memoria-reindex.ts
// Helper compartilhado de (re)indexacao e remocao de chunks no indice de
// memoria AGNOSTICO de origem (memoria_chunks, DD-01). Isola a dependencia
// de embeddings.ts/provider para reuso por TODAS as Edge Functions que
// precisam manter chunks sincronizados a um registro de dominio (ex.: a
// diretriz_producao de um SKU em produtos-catalogo, e demais diretrizes/
// criterios da sprint seguinte).
//
// Contrato idempotente (delete-then-insert governado por origem+registro_id):
//   - syncMemoriaChunks(): verbatim nao-vazio -> reindexa (limpa + regrava);
//     verbatim vazio/null -> remove os chunks do registro. Um unico ponto de
//     entrada cobre o ciclo "salvar diretriz" e "esvaziar diretriz".
//   - removeMemoriaChunks(): remocao explicita (ex.: ao deletar o registro).
//
// `db` deve ser service_role (escrita server-side contornando RLS no contexto
// da indexacao - SEC-05).
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import {
  EmbeddingError,
  type EmbeddingProvider,
  generateAndStoreMemoriaChunks,
} from "./embeddings.ts";
import { resolveEmbeddingProvider } from "./indexacao.ts";

/** Identificacao de um registro no indice de memoria (origem + registro_id). */
export interface MemoriaChunkRef {
  /** Discriminador da origem (ex.: 'produto', 'aviso', 'processo'). */
  origem: string;
  /** Id do registro de origem (ex.: produto_skus.id). */
  registroId: string;
}

export interface SyncMemoriaChunksParams extends MemoriaChunkRef {
  /** Discriminador fino do chunk (ex.: 'produto-cotacao'); null quando ausente. */
  tipo: string | null;
  /** Texto a indexar. Vazio/null aciona a remocao dos chunks do registro. */
  verbatim: string | null | undefined;
  /**
   * Provider de embeddings (injetavel para testes). Quando ausente, resolve o
   * provider padrao via config (bge-m3, vector(1024)).
   */
  provider?: EmbeddingProvider;
}

/**
 * Remove TODOS os chunks de memoria de um registro (origem + registro_id),
 * de forma idempotente (sem erro quando nao ha chunks). Lanca EmbeddingError
 * em falha de banco para manter o contrato de erro do indexador.
 */
export async function removeMemoriaChunks(
  db: SupabaseClient,
  ref: MemoriaChunkRef,
): Promise<void> {
  const { error } = await db
    .from("memoria_chunks")
    .delete()
    .eq("origem", ref.origem)
    .eq("registro_id", ref.registroId);
  if (error) {
    throw new EmbeddingError(`falha ao remover chunks de memoria: ${error.message}`);
  }
}

/**
 * Sincroniza os chunks de um registro com o seu texto canonico:
 *   - verbatim com conteudo -> delete-then-insert idempotente (reindexa).
 *   - verbatim vazio/null    -> remove os chunks do registro.
 * Retorna a quantidade de chunks resultante (0 quando removido/sem conteudo).
 */
export async function syncMemoriaChunks(
  db: SupabaseClient,
  params: SyncMemoriaChunksParams,
): Promise<number> {
  const verbatim = (params.verbatim ?? "").trim();

  if (verbatim === "") {
    await removeMemoriaChunks(db, { origem: params.origem, registroId: params.registroId });
    return 0;
  }

  // Provider: usa o injetado ou resolve pela config_indexacao (mesmo chokepoint
  // da escrita/leitura do acervo) -> escrita e busca seguem o mesmo motor, sem
  // divergencia de espaco vetorial. Degradacao graciosa: se a config nao puder
  // produzir um provider (sem chave no Vault / sem endpoint), a indexacao e
  // DIFERIDA (nao estoura). O registro de dominio (diretriz/politica) persiste
  // normalmente; os chunks serao gerados quando os embeddings forem religados
  // (backfill). Salvar o substrato nao pode depender da camada de IA online.
  let provider = params.provider;
  if (!provider) {
    try {
      provider = await resolveEmbeddingProvider();
    } catch (err) {
      console.warn(
        `[memoria-reindex] indexacao diferida (provider indisponivel: ${
          err instanceof Error ? err.message : String(err)
        }): ${params.origem}/${params.registroId}`,
      );
      return 0;
    }
  }
  const result = await generateAndStoreMemoriaChunks(db, {
    origem: params.origem,
    tipo: params.tipo,
    registroId: params.registroId,
    verbatim,
    provider,
  });
  return result.chunks;
}
