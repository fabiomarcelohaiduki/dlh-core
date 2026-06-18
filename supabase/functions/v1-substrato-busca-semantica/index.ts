// =====================================================================
// Edge Function: v1-substrato-busca-semantica
//   -> POST /v1/substrato/busca-semantica   (contrato versionado /v1, RNF-17)
//
// Busca semantica vetorial MULTI-ORIGEM (US-18, RF-21, RNF-09, DD-03):
//   - Recebe { query, limite?, escopo? } e retorna
//     { resultados: [{ aviso_id, registro_id, origem, verbatim, similaridade }] }.
//     Mantem `results: [{ id, score, verbatim }]` como espelho legado (compat
//     aditiva com o playground do cockpit, que ainda envia `topK`).
//   - Gera o embedding da query via MESMO provider plugavel da ingestao
//     (bge-m3, dimensao 1024, zero custo por token; NUNCA o Claude) e chama a
//     RPC origem-aware busca_semantica_chunks(p_embedding, p_limite, p_escopo).
//   - escopo (default 'tudo'): tudo|avisos|processos|processo-venda-governamental.
//     Sem filtro = federado; chunk de processo nao polui consulta de edital.
//   - limite e normalizado/limitado em [1, 50] (default 10); query vazia ou
//     acima de 2000 caracteres e rejeitada por validacao (422).
//   - Substrato sem embeddings indexados retorna lista vazia (distinto de
//     query valida cujos vizinhos existem).
//
// Autenticacao /v1 (RNF-01): aceita a API key de servico read-only da Lia
// (Bearer, guardada no Vault) OU a sessao do cockpit (playground humano).
// Sem credencial valida -> 401. A busca roda via service_role apos a borda
// autorizar (a RPC e SECURITY DEFINER, executavel so por service_role).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, principalLabel } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { EmbeddingError } from "../_shared/embeddings.ts";
import { resolveEmbeddingProvider } from "../_shared/indexacao.ts";
import { buscaSemanticaSchema, normalizeLimite, parseJsonBody } from "../_shared/validation.ts";
import type {
  BuscaSemanticaRegistro,
  BuscaSemanticaResponse,
  BuscaSemanticaResultItem,
} from "../_shared/types.ts";

/**
 * Linha retornada pela RPC public.busca_semantica_chunks (generalizada, DD-03).
 * Campos preservados (compat Lia): aviso_id, verbatim, similaridade. Os campos
 * aditivos origem/registro_id ficam disponiveis para escopos federados futuros.
 */
interface BuscaRow {
  aviso_id: string | null;
  verbatim: string | null;
  similaridade: number | null;
  origem: string | null;
  registro_id: string | null;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao primeiro: nao processa corpo sem credencial valida (401/403).
    const principal = await authenticateV1(req);

    // Validacao server-side (zod): query nao-vazia e <= MAX_QUERY_CHARS; escopo
    // opcional (default 'tudo'); limite normalizado abaixo. Falha de schema ->
    // 422 (query vazia ou acima do limite de caracteres).
    const { query, limite, topK, escopo } = await parseJsonBody(req, buscaSemanticaSchema, {
      validationStatus: 422,
    });
    // `limite` e o parametro novo; `topK` e o alias legado (playground). O clamp
    // garante o intervalo [1, 50]; ausente -> default.
    const normalizedLimite = normalizeLimite(limite ?? topK);

    // Embedding da query via MESMO provider com que o substrato foi indexado
    // (resolveEmbeddingProvider -> OpenAI/Vault, dim 1024). Casar o provider e
    // obrigatorio: provider divergente gera vetor incompativel -> 0 resultados.
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
        // Causa conhecida (provider indisponivel/timeout/dimensao): 502.
        throw new HttpError(
          502,
          "embedding_indisponivel",
          "falha ao gerar o embedding da query; servico de embeddings indisponivel",
        );
      }
      throw err;
    }

    // Busca HNSW (cosine) via RPC SECURITY DEFINER, executada server-side.
    // RPC generalizada (DD-03): assinatura (p_embedding vector(1024), p_limite,
    // p_escopo). p_escopo mapeia 1:1 o escopo validado: 'tudo' = federado
    // (avisos + processos); 'avisos'/'processos'/<tipo> filtram a origem sem
    // poluir consultas cruzadas. O vetor vai como array numerico
    // (PostgREST -> vector(1024)).
    const service = createServiceClient();
    const { data, error } = await service.rpc("busca_semantica_chunks", {
      p_embedding: queryVector,
      p_limite: normalizedLimite,
      p_escopo: escopo,
    });
    if (error) {
      throw new HttpError(500, "busca_semantica_failed", "falha ao executar a busca semantica");
    }

    const rows = (data ?? []) as BuscaRow[];

    // Contrato multi-origem (DD-03): preserva aviso_id/verbatim/similaridade e
    // adiciona registro_id/origem. aviso_id/registro_id podem ser null.
    const resultados: BuscaSemanticaRegistro[] = rows.map((row) => ({
      aviso_id: row.aviso_id ?? null,
      registro_id: row.registro_id ?? null,
      origem: row.origem ?? "",
      verbatim: row.verbatim ?? "",
      similaridade: typeof row.similaridade === "number" ? row.similaridade : 0,
    }));

    // Espelho legado (compat aditiva com o playground do cockpit).
    const results: BuscaSemanticaResultItem[] = rows.map((row) => ({
      id: row.aviso_id ?? row.registro_id ?? "",
      score: typeof row.similaridade === "number" ? row.similaridade : 0,
      verbatim: row.verbatim ?? "",
    }));

    // Auditoria: registra a consulta SEM o conteudo da query (RNF-08).
    await logSensitiveAction({
      tabela: "aviso_chunks",
      acao: "busca_semantica",
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        escopo,
        limite: normalizedLimite,
        resultados: resultados.length,
      },
    });

    const body: BuscaSemanticaResponse = { resultados, results };
    return jsonResponse(body, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "v1-substrato-busca-semantica" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
