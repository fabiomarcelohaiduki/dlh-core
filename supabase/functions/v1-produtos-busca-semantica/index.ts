// =====================================================================
// Edge Function: v1-produtos-busca-semantica  (Dominio F - Consumo pela Lia)
//   -> POST /v1-produtos-busca-semantica
//
// Busca semantica de criterios/diretrizes/producao do dominio Produtos
// (US-14, RF-24, RF-25). Gera o embedding bge-m3 vector(1024) da query
// (MESMO provider plugavel da ingestao, zero custo por token; nunca o Claude)
// e chama a RPC origem-aware busca_semantica_chunks(p_embedding, p_limite,
// p_escopo='produto-cotacao'), que ativa o ramo `m.tipo = p_escopo` em
// memoria_chunks, isolando o dominio (chunk de produto nao polui outras
// consultas e vice-versa).
//
// Validacao (criterios de aceite): query obrigatoria, 1..2000 caracteres
// (400 acima/vazia); limite default 10, maximo 50 (valores acima REJEITADOS
// com 400 - diferente do substrato, que clampa). Escopo FIXO no handler.
//
// Autenticacao /v1 (RNF-01/RNF-02): authenticateV1 aceita a API key de
// servico read-only da Lia (Bearer, Vault) OU a sessao do cockpit. Sem
// credencial valida -> 401; sessao humana fora da allowlist -> 403. A busca
// roda via service_role (a RPC e SECURITY DEFINER, executavel so por
// service_role). logSensitiveAction registra principal + escopo (RNF-03).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, principalLabel } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { createEmbeddingProvider, EmbeddingError } from "../_shared/embeddings.ts";
import {
  parseJsonBody,
  PRODUTOS_BUSCA_DEFAULT_LIMITE,
  PRODUTOS_BUSCA_ESCOPO,
  produtosBuscaSemanticaSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "v1-produtos-busca-semantica";

/**
 * Linha retornada pela RPC public.busca_semantica_chunks. No escopo
 * 'produto-cotacao' os resultados vem do ramo memoria_chunks (aviso_id null);
 * registro_id e a referencia generica do registro de origem (ex.: sku.id,
 * cotacao_diretrizes.id, politica_participacao.id).
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

    // Validacao server-side (zod): query 1..2000 chars (vazia/acima -> 400);
    // limite opcional, inteiro positivo, maximo 50 (acima -> 400, NAO clampa).
    const { query, limite } = await parseJsonBody(req, produtosBuscaSemanticaSchema);
    const normalizedLimite = limite ?? PRODUTOS_BUSCA_DEFAULT_LIMITE;

    // Embedding da query via MESMO provider plugavel da ingestao (bge-m3, 1024).
    const provider = createEmbeddingProvider();
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
    // p_escopo FIXO em 'produto-cotacao' ativa o ramo `m.tipo = p_escopo`
    // em memoria_chunks, isolando o dominio Produtos.
    const service = createServiceClient();
    const { data, error } = await service.rpc("busca_semantica_chunks", {
      p_embedding: queryVector,
      p_limite: normalizedLimite,
      p_escopo: PRODUTOS_BUSCA_ESCOPO,
    });
    if (error) {
      throw new HttpError(500, "busca_semantica_failed", "falha ao executar a busca semantica");
    }

    const rows = (data ?? []) as BuscaRow[];

    // Contrato do dominio Produtos: registro_id, tipo (escopo fixo), verbatim,
    // similaridade. registro_id pode ser null (defensivo).
    const resultados = rows.map((row) => ({
      registro_id: row.registro_id ?? null,
      tipo: PRODUTOS_BUSCA_ESCOPO,
      verbatim: row.verbatim ?? "",
      similaridade: typeof row.similaridade === "number" ? row.similaridade : 0,
    }));

    // Auditoria do acesso /v1: principal + escopo, SEM o conteudo da query.
    await logSensitiveAction({
      tabela: "memoria_chunks",
      acao: "v1_busca_semantica",
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        escopo: PRODUTOS_BUSCA_ESCOPO,
        limite: normalizedLimite,
        resultados: resultados.length,
      },
    });

    return jsonResponse({ version: "v1", resultados }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
