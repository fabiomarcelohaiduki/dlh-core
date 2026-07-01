// =====================================================================
// Edge Function: v1-relacionamentos-buscar
//   -> POST /v1/relacionamentos/buscar
//
// MCP read-only da Lia: busca por linguagem natural e devolve o ponto
// de entrada no grafo. A busca vetorial acha documentos candidatos; para
// cada documento encontrado, a Edge tenta expandir a vizinhanca confirmada
// em public.relacoes via public.relacoes_vizinhanca.
//
// Contrato:
//   Input:  { consulta, limite?, profundidade? }
//   Output: { nos_grafo, chunks_vetoriais, rota_sugerida, score_dual }
//
// Escopo deliberado da Fase 1:
//   - Vetorial em documentos: usa busca_semantica_documentos, igual ao acervo.
//   - Grafo: usa documentos como nos ancora e retorna vizinhos confirmados.
//   - Sem criar nova RPC: reusa relacoes_vizinhanca e a infraestrutura atual.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, LIA_SERVICE_SCOPE, principalLabel } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { resolveEmbeddingProvider } from "../_shared/indexacao.ts";
import { EmbeddingError } from "../_shared/embeddings.ts";
import {
  normalizeLimite,
  parseJsonBody,
  type V1RelacionamentosBuscarPayload,
  v1RelacionamentosBuscarPayloadSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "v1-relacionamentos-buscar";
const DEFAULT_PROFUNDIDADE = 2;
const MAX_ANCORAS_GRAFO = 5;

interface AcervoRow {
  documento_id: string | null;
  chunk_index: number | null;
  verbatim: string | null;
  similaridade: number | null;
  nome_arquivo: string | null;
  tipo_documento: string | null;
  fontes: string[] | null;
}

interface VizinhoRpcRow {
  tipo: string;
  id: string;
  profundidade: number;
  caminho: string[];
}

interface ChunkVetorial {
  documento_id: string | null;
  chunk_index: number | null;
  verbatim: string;
  similaridade: number;
  nome_arquivo: string | null;
  tipo_documento: string | null;
  fontes: string[];
}

interface NoGrafo {
  tipo: string;
  id: string;
  label: string;
  profundidade: number;
  caminho: string[];
  origem: "vetorial" | "grafo";
}

type ServiceClient = ReturnType<typeof createServiceClient>;

async function gerarEmbeddingConsulta(consulta: string): Promise<number[]> {
  const provider = await resolveEmbeddingProvider();
  try {
    const [vector] = await provider.embed([consulta]);
    if (!vector) throw new EmbeddingError("provider nao retornou embedding para a consulta");
    return vector;
  } catch (err) {
    if (err instanceof EmbeddingError) {
      throw new HttpError(
        502,
        "embedding_indisponivel",
        "falha ao gerar o embedding da consulta; servico de embeddings indisponivel",
      );
    }
    throw err;
  }
}

async function buscarChunks(
  db: ServiceClient,
  queryVector: number[],
  limite: number,
): Promise<ChunkVetorial[]> {
  const { data, error } = await db.rpc("busca_semantica_documentos", {
    p_embedding: queryVector,
    p_limite: limite,
  });
  if (error) {
    throw new HttpError(500, "busca_semantica_failed", "falha ao executar a busca semantica");
  }
  return ((data ?? []) as AcervoRow[]).map((row) => ({
    documento_id: row.documento_id ?? null,
    chunk_index: typeof row.chunk_index === "number" ? row.chunk_index : null,
    verbatim: row.verbatim ?? "",
    similaridade: typeof row.similaridade === "number" ? row.similaridade : 0,
    nome_arquivo: row.nome_arquivo ?? null,
    tipo_documento: row.tipo_documento ?? null,
    fontes: Array.isArray(row.fontes) ? row.fontes : [],
  }));
}

async function expandirDocumento(
  db: ServiceClient,
  documentoId: string,
  profundidade: number,
): Promise<VizinhoRpcRow[]> {
  const { data, error } = await db.rpc("relacoes_vizinhanca", {
    p_tipo: "documento",
    p_id: documentoId,
    p_profundidade: profundidade,
  });
  if (error) {
    console.warn("[v1-relacionamentos-buscar] falha ao expandir vizinhanca", {
      documento_id: documentoId,
      mensagem: error.message,
    });
    return [];
  }
  return (data ?? []) as VizinhoRpcRow[];
}

function montarNosGrafo(chunks: ChunkVetorial[], vizinhancas: VizinhoRpcRow[][]): NoGrafo[] {
  const porChave = new Map<string, NoGrafo>();

  for (const chunk of chunks) {
    if (!chunk.documento_id) continue;
    const chave = `documento:${chunk.documento_id}`;
    if (!porChave.has(chave)) {
      porChave.set(chave, {
        tipo: "documento",
        id: chunk.documento_id,
        label: chunk.nome_arquivo ?? chunk.documento_id,
        profundidade: 0,
        caminho: [],
        origem: "vetorial",
      });
    }
  }

  for (const rows of vizinhancas) {
    for (const row of rows) {
      const chave = `${row.tipo}:${row.id}`;
      if (porChave.has(chave)) continue;
      porChave.set(chave, {
        tipo: row.tipo,
        id: row.id,
        label: `${row.tipo}:${row.id}`,
        profundidade: row.profundidade,
        caminho: row.caminho ?? [],
        origem: "grafo",
      });
    }
  }

  return [...porChave.values()].sort((a, b) => {
    if (a.profundidade !== b.profundidade) return a.profundidade - b.profundidade;
    return `${a.tipo}:${a.id}`.localeCompare(`${b.tipo}:${b.id}`);
  });
}

function montarRotaSugerida(nos: NoGrafo[], chunks: ChunkVetorial[]): string | null {
  const primeiroChunk = chunks.find((chunk) => chunk.documento_id);
  if (!primeiroChunk?.documento_id) return null;
  const vizinho = nos.find((no) => no.origem === "grafo" && no.tipo !== "documento");
  if (!vizinho) {
    return `documento:${primeiroChunk.documento_id}`;
  }
  return `documento:${primeiroChunk.documento_id} -> ${vizinho.tipo}:${vizinho.id}`;
}

function calcularScoreDual(chunks: ChunkVetorial[], nos: NoGrafo[]): number {
  const melhorSimilaridade = Math.max(0, ...chunks.map((chunk) => chunk.similaridade));
  const temGrafo = nos.some((no) => no.origem === "grafo" && no.profundidade > 0);
  const bonusGrafo = temGrafo ? 0.1 : 0;
  return Math.min(1, Number((melhorSimilaridade + bonusGrafo).toFixed(6)));
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    const principal = await authenticateV1(req, { requiredScope: LIA_SERVICE_SCOPE });
    const payload: V1RelacionamentosBuscarPayload = await parseJsonBody(
      req,
      v1RelacionamentosBuscarPayloadSchema,
      { validationStatus: 422 },
    );

    const limite = normalizeLimite(payload.limite);
    const profundidade = payload.profundidade ?? DEFAULT_PROFUNDIDADE;
    const db = createServiceClient();
    const queryVector = await gerarEmbeddingConsulta(payload.consulta);
    const chunks_vetoriais = await buscarChunks(db, queryVector, limite);

    const documentoIds = [
      ...new Set(
        chunks_vetoriais
          .map((chunk) => chunk.documento_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ].slice(0, MAX_ANCORAS_GRAFO);

    const vizinhancas = await Promise.all(
      documentoIds.map((documentoId) => expandirDocumento(db, documentoId, profundidade)),
    );
    const nos_grafo = montarNosGrafo(chunks_vetoriais, vizinhancas);
    const rota_sugerida = montarRotaSugerida(nos_grafo, chunks_vetoriais);
    const score_dual = calcularScoreDual(chunks_vetoriais, nos_grafo);

    await logSensitiveAction({
      tabela: "relacionamentos",
      acao: "v1_buscar",
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        limite,
        profundidade,
        chunks: chunks_vetoriais.length,
        ancoras_grafo: documentoIds.length,
        nos_grafo: nos_grafo.length,
        score_dual,
      },
    });

    return jsonResponse({ nos_grafo, chunks_vetoriais, rota_sugerida, score_dual }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

getEnv();

Deno.serve(handler);
