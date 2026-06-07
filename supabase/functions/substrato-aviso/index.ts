// =====================================================================
// Edge Function: substrato-aviso  ->  GET /substrato/avisos/:id
// Detalhe completo de um aviso para a tela de investigacao de erro (US-14):
//   { id, conteudoVerbatim, payloadBruto, indice }
// onde `indice` traz metadados de chunks/embeddings + arquivos + status.
//
//  - id inexistente/invalido -> 404 (front exibe "edital nao encontrado").
//  - Exige sessao autorizada; conteudoVerbatim/payloadBruto nunca em rota
//    publica (este endpoint e protegido por _shared/auth.ts + RLS).
//  - Acesso a conteudo sensivel e auditado (audit_log).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import type { ArquivoMetadata, AvisoDetalhe, ChunkMetadata } from "../_shared/types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FUNCTION_SEGMENT = "substrato-aviso";

/**
 * Extrai o id do aviso da rota (.../substrato-aviso/<id> ou .../avisos/<id>)
 * com fallback para ?id=. Valida formato UUID (id invalido -> 404 tratavel).
 */
function extractAvisoId(req: Request): string {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);

  let candidate: string | undefined;
  const fnIdx = parts.indexOf(FUNCTION_SEGMENT);
  if (fnIdx >= 0 && parts.length > fnIdx + 1) {
    candidate = parts[fnIdx + 1];
  }
  if (!candidate) {
    const avisosIdx = parts.indexOf("avisos");
    if (avisosIdx >= 0 && parts.length > avisosIdx + 1) {
      candidate = parts[avisosIdx + 1];
    }
  }
  if (!candidate) {
    candidate = url.searchParams.get("id") ?? undefined;
  }

  if (!candidate || !UUID_RE.test(candidate)) {
    // id ausente/invalido e tratado como "nao encontrado" para o front.
    throw new HttpError(404, "edital_nao_encontrado", "edital nao encontrado/indisponivel");
  }
  return candidate;
}

interface AvisoRow {
  id: string;
  conteudo_verbatim: string;
  payload_bruto: unknown;
  status_indexacao: string | null;
}

interface ChunkRow {
  id: string;
  ordem: number | null;
  embedding: number[] | null;
}

interface ArquivoRow {
  id: string;
  nome_arquivo: string | null;
  extensao: string | null;
  tamanho_bytes: number | null;
  storage_path: string | null;
  status_tratamento: string | null;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");
    const avisoId = extractAvisoId(req);
    const { db, email } = await requireAuthorizedUser(req);

    // Aviso base (verbatim + payload bruto integral).
    const { data: aviso, error: avisoError } = await db
      .from("avisos")
      .select("id, conteudo_verbatim, payload_bruto, status_indexacao")
      .eq("id", avisoId)
      .maybeSingle();

    if (avisoError) {
      throw new HttpError(500, "aviso_query_failed", "falha ao consultar o aviso");
    }
    if (!aviso) {
      throw new HttpError(404, "edital_nao_encontrado", "edital nao encontrado/indisponivel");
    }
    const avisoRow = aviso as AvisoRow;

    // Chunks: apenas metadados (a SPEC pede chunks/embeddings em metadados;
    // o vetor bruto nao e exposto, so a presenca e a dimensao).
    const { data: chunkData, error: chunkError } = await db
      .from("aviso_chunks")
      .select("id, ordem, embedding")
      .eq("aviso_id", avisoId)
      .order("ordem", { ascending: true });

    if (chunkError) {
      throw new HttpError(500, "chunks_query_failed", "falha ao consultar chunks do aviso");
    }

    // Arquivos do edital (metadados; texto_extraido nao exposto na listagem).
    const { data: arquivoData, error: arquivoError } = await db
      .from("aviso_arquivos")
      .select("id, nome_arquivo, extensao, tamanho_bytes, storage_path, status_tratamento")
      .eq("aviso_id", avisoId);

    if (arquivoError) {
      throw new HttpError(500, "arquivos_query_failed", "falha ao consultar arquivos do aviso");
    }

    const chunks: ChunkMetadata[] = ((chunkData ?? []) as ChunkRow[]).map((row) => ({
      id: row.id,
      ordem: row.ordem,
      temEmbedding: Array.isArray(row.embedding) && row.embedding.length > 0,
      dimensoes: Array.isArray(row.embedding) ? row.embedding.length : null,
    }));

    const arquivos: ArquivoMetadata[] = ((arquivoData ?? []) as ArquivoRow[]).map((row) => ({
      id: row.id,
      nomeArquivo: row.nome_arquivo,
      extensao: row.extensao,
      tamanhoBytes: row.tamanho_bytes,
      storagePath: row.storage_path,
      statusTratamento: row.status_tratamento,
    }));

    // Auditoria: acesso a conteudo sensivel (verbatim/payload) (RNF-08).
    await logSensitiveAction({
      tabela: "avisos",
      acao: "read_detail",
      registroId: avisoRow.id,
      usuario: email,
    });

    const body: AvisoDetalhe = {
      id: avisoRow.id,
      conteudoVerbatim: avisoRow.conteudo_verbatim,
      payloadBruto: avisoRow.payload_bruto,
      indice: {
        statusIndexacao: avisoRow.status_indexacao,
        chunks,
        arquivos,
      },
    };
    return jsonResponse(body, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "substrato-aviso" });
  }
}

getEnv();

Deno.serve(handler);
