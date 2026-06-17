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
//     IVFFlat (cosine) sobre memoria_chunks origem='documento' e enriquece o
//     top-K com nome/tipo do documento e as fontes (documento_vinculos).
//   - BUSCA HIBRIDA (config_busca.hibrida_ativa): quando ligada, roda tambem a
//     perna lexical (busca_lexical_documentos) em paralelo e funde as duas por
//     Reciprocal Rank Fusion (RRF) — o vetorial acha por significado, a lexical
//     ancora termo exato (numero de edital, UASG, CATMAT, CNPJ). A perna
//     lexical e FAIL-OPEN: se falhar, cai no vetorial puro.
//   - RERANK (config_busca.rerank_ativo): quando ligado, roda DEPOIS da fusao,
//     sobre o conjunto unido (Cohere). Tambem fail-open.
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
import { loadConfigBusca, resolveRerankProvider } from "../_shared/rerank.ts";
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

/** Linha retornada pela RPC public.busca_lexical_documentos (perna lexical). */
interface AcervoLexicalRow {
  documento_id: string | null;
  chunk_index: number | null;
  verbatim: string | null;
  rank_lexical: number | null;
  nome_arquivo: string | null;
  tipo_documento: string | null;
  fontes: string[] | null;
}

/**
 * Constante k do Reciprocal Rank Fusion. Atenua o peso das posicoes do topo
 * para que itens bem ranqueados em QUALQUER perna contribuam, e itens
 * presentes nas DUAS subam mais. 60 e o valor canonico da literatura RRF;
 * raramente ajustado, mantido como constante (nao exposto no cockpit).
 */
const RRF_K = 60;

/** Chave de fusao = o CHUNK (documento + indice), unidade das duas pernas. */
function chaveChunk(documentoId: string | null, chunkIndex: number | null): string {
  return `${documentoId ?? ""}#${chunkIndex ?? ""}`;
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
  /** Score de relevancia do reranker (Cohere); null quando rerank nao aplicado. */
  relevancia: number | null;
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

    // Config de busca (singleton config_busca, administravel pelo cockpit):
    // master switch da fusao hibrida + do rerank, e tamanhos dos pools.
    const service = createServiceClient();
    const configBusca = await loadConfigBusca(service);
    const usarRerank = configBusca?.rerankAtivo === true;
    const usarHibrida = configBusca?.hibridaAtiva === true;

    // Pool de candidatos por perna. Tanto rerank quanto fusao precisam de mais
    // material que o limite final para reordenar; a RPC clampa em [1,50]
    // (defense in depth). Sem nenhum dos dois, busca so o limite pedido.
    const candidatos = usarRerank || usarHibrida
      ? Math.max(configBusca!.rerankCandidatos, normalizedLimite)
      : normalizedLimite;
    const candidatosLexical = usarHibrida
      ? Math.max(configBusca!.hibridaCandidatosLexical, normalizedLimite)
      : 0;

    // Perna vetorial (sempre) + perna lexical (so na fusao), em paralelo. A
    // lexical e FAIL-OPEN: se a RPC falhar, a busca cai no vetorial puro.
    const [vetorialRes, lexicalRes] = await Promise.all([
      service.rpc("busca_semantica_documentos", {
        p_embedding: queryVector,
        p_limite: candidatos,
      }),
      usarHibrida
        ? service.rpc("busca_lexical_documentos", {
          p_query: query,
          p_limite: candidatosLexical,
        })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (vetorialRes.error) {
      throw new HttpError(500, "busca_semantica_failed", "falha ao executar a busca semantica");
    }

    const vetorialRows = (vetorialRes.data ?? []) as AcervoRow[];
    let lexicalRows: AcervoLexicalRow[] = [];
    // Status da perna lexical, para auditoria/observabilidade.
    let hibridaStatus: "aplicado" | "desligado" | "fail_open" = usarHibrida
      ? "aplicado"
      : "desligado";
    if (usarHibrida) {
      if (lexicalRes.error) {
        // Fail-open: a falha lexical nao derruba a busca; segue so com vetorial.
        console.warn(
          `[hibrida] fail-open lexical: ${
            (lexicalRes.error as { message?: string }).message ?? "erro desconhecido"
          }`,
        );
        hibridaStatus = "fail_open";
      } else {
        lexicalRows = (lexicalRes.data ?? []) as AcervoLexicalRow[];
      }
    }

    let resultados: AcervoResultado[];
    if (!usarHibrida || hibridaStatus === "fail_open") {
      // Caminho vetorial puro (fusao desligada ou lexical indisponivel).
      resultados = vetorialRows.map((row) => ({
        documento_id: row.documento_id ?? null,
        chunk_index: typeof row.chunk_index === "number" ? row.chunk_index : null,
        verbatim: row.verbatim ?? "",
        similaridade: typeof row.similaridade === "number" ? row.similaridade : 0,
        nome_arquivo: row.nome_arquivo ?? null,
        tipo_documento: row.tipo_documento ?? null,
        fontes: Array.isArray(row.fontes) ? row.fontes : [],
        relevancia: null,
      }));
    } else {
      // Fusao Reciprocal Rank Fusion: cada perna contribui 1/(k + posicao);
      // o chunk presente nas DUAS soma as duas contribuicoes e sobe. A ordem
      // de cada perna ja vem do banco (vetorial por distancia, lexical por
      // rank), entao o indice do array E a posicao (0-based).
      const fusao = new Map<string, AcervoResultado & { rrf: number }>();

      vetorialRows.forEach((row, i) => {
        const k = chaveChunk(row.documento_id ?? null, row.chunk_index ?? null);
        const atual = fusao.get(k);
        const contrib = 1 / (RRF_K + i + 1);
        if (atual) {
          atual.rrf += contrib;
          atual.similaridade = typeof row.similaridade === "number" ? row.similaridade : 0;
        } else {
          fusao.set(k, {
            documento_id: row.documento_id ?? null,
            chunk_index: typeof row.chunk_index === "number" ? row.chunk_index : null,
            verbatim: row.verbatim ?? "",
            similaridade: typeof row.similaridade === "number" ? row.similaridade : 0,
            nome_arquivo: row.nome_arquivo ?? null,
            tipo_documento: row.tipo_documento ?? null,
            fontes: Array.isArray(row.fontes) ? row.fontes : [],
            relevancia: null,
            rrf: contrib,
          });
        }
      });

      lexicalRows.forEach((row, i) => {
        const k = chaveChunk(row.documento_id ?? null, row.chunk_index ?? null);
        const atual = fusao.get(k);
        const contrib = 1 / (RRF_K + i + 1);
        if (atual) {
          atual.rrf += contrib;
        } else {
          fusao.set(k, {
            documento_id: row.documento_id ?? null,
            chunk_index: typeof row.chunk_index === "number" ? row.chunk_index : null,
            verbatim: row.verbatim ?? "",
            // Chunk so-lexical nao tem similaridade vetorial.
            similaridade: 0,
            nome_arquivo: row.nome_arquivo ?? null,
            tipo_documento: row.tipo_documento ?? null,
            fontes: Array.isArray(row.fontes) ? row.fontes : [],
            relevancia: null,
            rrf: contrib,
          });
        }
      });

      resultados = [...fusao.values()]
        .sort((a, b) => b.rrf - a.rrf)
        .map(({ rrf: _rrf, ...rest }) => rest);
    }

    // Limita o material que segue para o rerank (Cohere) ao pool configurado,
    // mantendo custo/latencia previsiveis quando a fusao une as duas pernas.
    if (usarRerank) {
      resultados = resultados.slice(
        0,
        Math.max(configBusca!.rerankCandidatos, normalizedLimite),
      );
    }

    // RERANK (fail-open): reordena os candidatos por relevancia real e corta no
    // limite pedido. Se a Cohere falhar (chave ausente, fora do ar, timeout), a
    // busca devolve o top-N VETORIAL — o rerank melhora a ordem, nunca derruba.
    let rerankStatus: "aplicado" | "desligado" | "fail_open" | "poucos_candidatos";
    if (!usarRerank) {
      rerankStatus = "desligado";
      resultados = resultados.slice(0, normalizedLimite);
    } else if (resultados.length <= 1) {
      rerankStatus = "poucos_candidatos";
      resultados = resultados.slice(0, normalizedLimite);
    } else {
      try {
        const provider = await resolveRerankProvider(configBusca!.rerankModelo);
        const ranked = await provider.rerank(
          query,
          resultados.map((r) => r.verbatim),
          normalizedLimite,
        );
        // Dedup defensivo: ignora indices repetidos que a Cohere possa devolver e
        // corta no limite pedido (parseRerankResponse valida range, nao unicidade).
        const vistos = new Set<number>();
        const reordenados: AcervoResultado[] = [];
        for (const r of ranked) {
          if (vistos.has(r.index)) continue;
          vistos.add(r.index);
          reordenados.push({ ...resultados[r.index], relevancia: r.relevanceScore });
          if (reordenados.length >= normalizedLimite) break;
        }
        resultados = reordenados;
        rerankStatus = "aplicado";
      } catch (err) {
        // Fail-open: mantem a ordem vetorial, apenas corta no limite pedido.
        console.warn(
          `[rerank] fail-open: ${err instanceof Error ? err.message : String(err)}`,
        );
        rerankStatus = "fail_open";
        resultados = resultados.slice(0, normalizedLimite);
      }
    }

    // Auditoria: registra a consulta SEM o conteudo da query.
    await logSensitiveAction({
      tabela: "memoria_chunks",
      acao: "busca_semantica_acervo",
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        limite: normalizedLimite,
        candidatos,
        candidatos_lexical: candidatosLexical,
        hibrida_status: hibridaStatus,
        vetorial_chunks: vetorialRows.length,
        lexical_chunks: lexicalRows.length,
        rerank_status: rerankStatus,
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
