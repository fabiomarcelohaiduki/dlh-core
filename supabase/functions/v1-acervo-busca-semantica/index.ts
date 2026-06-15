// =====================================================================
// Edge Function: v1-acervo-busca-semantica
//   -> POST /v1/acervo/busca-semantica   (contrato versionado /v1)
//
// Busca semantica vetorial focada no ACERVO de documentos extraidos:
//   - Recebe { query, limite? } e retorna
//     { resultados: [{ documento_id, chunk_index, verbatim, similaridade,
//       nome_arquivo, tipo_documento, fontes }] }.
//   - Gera o embedding da query com o MESMO provider/modelo da INDEXACAO do
//     acervo (OpenAI text-embedding-3-small, dim 1024) via
//     resolveEmbeddingProvider() — NUNCA o provider default do env (bge-m3),
//     que produziria vetores em outro espaco e zeraria a relevancia.
//   - Chama a RPC busca_semantica_documentos(p_embedding, p_limite), que faz
//     HNSW (cosine) sobre memoria_chunks origem='documento' e enriquece o
//     top-K com nome/tipo do documento e as fontes (documento_vinculos).
//   - limite e normalizado/limitado em [1, 50] (default 10); query vazia ou
//     acima de 2000 caracteres e rejeitada por validacao (422).
//
// Autenticacao /v1: aceita a API key de servico read-only da Lia (Bearer,
// guardada no Vault) OU a sessao do cockpit. Sem credencial valida -> 401.
// A busca roda via service_role apos a borda autorizar (a RPC e SECURITY
// DEFINER, executavel so por service_role).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, principalLabel } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { resolveEmbeddingProvider } from "../_shared/indexacao.ts";
import { EmbeddingError } from "../_shared/embeddings.ts";
import { buscaSemanticaSchema, normalizeLimite, parseJsonBody } from "../_shared/validation.ts";

/** Linha retornada pela RPC public.busca_semantica_documentos. */
interface AcervoRow {
  documento_id: string | null;
  chunk_index: number | null;
  verbatim: string | null;
  similaridade: number | null;
  nome_arquivo: string | null;
  tipo_documento: string | null;
  fontes: string[] | null;
}

/** Item do contrato de saida (acervo). */
interface AcervoResultado {
  documento_id: string | null;
  chunk_index: number | null;
  verbatim: string;
  similaridade: number;
  nome_arquivo: string | null;
  tipo_documento: string | null;
  fontes: string[];
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao primeiro: nao processa corpo sem credencial valida (401/403).
    const principal = await authenticateV1(req);

    // Validacao server-side (zod): query nao-vazia e <= MAX_QUERY_CHARS; limite
    // normalizado abaixo. O campo escopo do schema compartilhado e ignorado
    // aqui (acervo nao e multi-origem). Falha de schema -> 422.
    const { query, limite, topK } = await parseJsonBody(req, buscaSemanticaSchema, {
      validationStatus: 422,
    });
    const normalizedLimite = normalizeLimite(limite ?? topK);

    // Embedding da query com o MESMO provider da indexacao do acervo (OpenAI
    // via Vault). Espaco consistente com os vetores armazenados.
    const provider = await resolveEmbeddingProvider();
    let queryVector: number[];
    try {
      const [vector] = await provider.embed([query]);
      if (!vector) {
        throw new EmbeddingError("provider nao retornou embedding para a query");
      }
      queryVector = vector;
    } catch (err) {
      if (err instanceof EmbeddingError) {
        throw new HttpError(
          502,
          "embedding_indisponivel",
          "falha ao gerar o embedding da query; servico de embeddings indisponivel",
        );
      }
      throw err;
    }

    // Busca HNSW (cosine) via RPC SECURITY DEFINER, executada server-side.
    const service = createServiceClient();
    const { data, error } = await service.rpc("busca_semantica_documentos", {
      p_embedding: queryVector,
      p_limite: normalizedLimite,
    });
    if (error) {
      throw new HttpError(500, "busca_semantica_failed", "falha ao executar a busca semantica");
    }

    const rows = (data ?? []) as AcervoRow[];
    const resultados: AcervoResultado[] = rows.map((row) => ({
      documento_id: row.documento_id ?? null,
      chunk_index: typeof row.chunk_index === "number" ? row.chunk_index : null,
      verbatim: row.verbatim ?? "",
      similaridade: typeof row.similaridade === "number" ? row.similaridade : 0,
      nome_arquivo: row.nome_arquivo ?? null,
      tipo_documento: row.tipo_documento ?? null,
      fontes: Array.isArray(row.fontes) ? row.fontes : [],
    }));

    // Auditoria: registra a consulta SEM o conteudo da query.
    await logSensitiveAction({
      tabela: "memoria_chunks",
      acao: "busca_semantica_acervo",
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        limite: normalizedLimite,
        resultados: resultados.length,
      },
    });

    return jsonResponse({ resultados }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "v1-acervo-busca-semantica" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
