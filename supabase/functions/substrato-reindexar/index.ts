// =====================================================================
// Edge Function: substrato-reindexar -> POST /substrato/avisos/:id/reindexar
// Reprocessa APENAS um item (US-08/US-16):
//   - reindexacao dos embeddings do conteudo verbatim integro.
//
// NB: a re-extracao de arquivos a partir do binario no Storage foi aposentada
// junto com a trilha v0 (decisao 2026-06-08: NAO guardar binario). O reprocesso
// reindexa o verbatim ja persistido no aviso.
//
//   - Atualiza erros_ingestao.status_reprocesso evitando disparo duplicado
//     para o mesmo item (marca 'em_andamento' -> 'resolvido'/'erro').
//   - Exige sessao autorizada (_shared/auth.ts) e registra audit trail.
//   - Retorna { status }.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createEmbeddingProvider, generateAndStoreChunks } from "../_shared/embeddings.ts";
import { errorMessage } from "../_shared/ingest-errors.ts";
import type { ReprocessarResponse } from "../_shared/types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FUNCTION_SEGMENT = "substrato-reindexar";

/** Extrai e valida o id do aviso da rota (.../<id>/reindexar ou ?id=). */
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
    throw new HttpError(404, "edital_nao_encontrado", "edital nao encontrado/indisponivel");
  }
  return candidate;
}

interface AvisoRow {
  id: string;
  conteudo_verbatim: string;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    const avisoId = extractAvisoId(req);

    // Autorizacao da sessao humana (defense in depth junto a RLS).
    const { email } = await requireAuthorizedUser(req);

    // Processamento server-side (escrita em chunks/arquivos) via service_role.
    const service = createServiceClient();

    const { data: aviso, error: avisoError } = await service
      .from("avisos")
      .select("id, conteudo_verbatim")
      .eq("id", avisoId)
      .maybeSingle();
    if (avisoError) {
      throw new HttpError(500, "aviso_query_failed", "falha ao consultar o aviso");
    }
    if (!aviso) {
      throw new HttpError(404, "edital_nao_encontrado", "edital nao encontrado/indisponivel");
    }
    const avisoRow = aviso as AvisoRow;

    // Anti-duplo-disparo do reprocesso: se ja houver reprocesso em andamento
    // para este item, nao dispara de novo (US-16/RF-40).
    const { data: emReprocesso, error: reprocError } = await service
      .from("erros_ingestao")
      .select("id")
      .eq("aviso_id", avisoId)
      .eq("status_reprocesso", "em_andamento")
      .limit(1);
    if (reprocError) {
      throw new HttpError(500, "reprocesso_query_failed", "falha ao verificar reprocesso do item");
    }
    if (emReprocesso && emReprocesso.length > 0) {
      const body: ReprocessarResponse = { status: "em_andamento" };
      return jsonResponse(body, 200);
    }

    // Marca os erros do item como em reprocesso (evita disparo duplicado).
    await service
      .from("erros_ingestao")
      .update({ status_reprocesso: "em_andamento" })
      .eq("aviso_id", avisoId);

    const embeddingProvider = createEmbeddingProvider();

    try {
      // Reindexacao dos embeddings do verbatim integro.
      await service.from("avisos").update({ status_indexacao: "em_andamento" }).eq("id", avisoId);
      await generateAndStoreChunks(service, {
        avisoId,
        verbatim: avisoRow.conteudo_verbatim,
        provider: embeddingProvider,
      });
      await service.from("avisos").update({ status_indexacao: "indexado" }).eq("id", avisoId);

      // Sucesso: resolve os erros do item.
      await service
        .from("erros_ingestao")
        .update({ status_reprocesso: "resolvido" })
        .eq("aviso_id", avisoId)
        .eq("status_reprocesso", "em_andamento");

      await logSensitiveAction({
        tabela: "avisos",
        acao: "reindexar",
        registroId: avisoId,
        usuario: email,
        dadosNovos: { resultado: "reprocessado" },
      });

      const body: ReprocessarResponse = { status: "reprocessado" };
      return jsonResponse(body, 200);
    } catch (procErr) {
      // Falha do reprocesso: marca erro e propaga estado de indexacao.
      await service.from("avisos").update({ status_indexacao: "erro" }).eq("id", avisoId);
      await service
        .from("erros_ingestao")
        .update({ status_reprocesso: "erro" })
        .eq("aviso_id", avisoId)
        .eq("status_reprocesso", "em_andamento");

      await logSensitiveAction({
        tabela: "avisos",
        acao: "reindexar",
        registroId: avisoId,
        usuario: email,
        dadosNovos: { resultado: "erro", motivo: errorMessage(procErr) },
      });

      throw new HttpError(
        500,
        "reprocesso_falhou",
        "falha ao reprocessar o item; verifique os erros de ingestao",
      );
    }
  } catch (err) {
    return await errorResponse(err, { fn: "substrato-reindexar" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
