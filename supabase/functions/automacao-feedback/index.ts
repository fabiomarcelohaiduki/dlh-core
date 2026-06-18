// =====================================================================
// Edge Function: automacao-feedback  (cockpit - feedback humano)
//   -> POST /automacao-feedback
//
// Grava o `feedback_humano` (correto/incorreto) na DECISAO VIGENTE do aviso
// (ultima linha de triagem_decisoes) e gera IMEDIATAMENTE um exemplo rotulado
// em triagem_exemplos (texto + embedding 1024-d), de forma IDEMPOTENTE por
// (aviso, veredito vigente): reavaliar ATUALIZA a decisao e SUBSTITUI o exemplo
// associado, sem duplicar linhas. Contrato 3.2.4 (RF-18/19, US-11/13, E1/E2).
//
// veredito_rotulado = `rotulo_correto` quando feedback = incorreto; quando
// correto, e o proprio veredito vigente. `rotulo_correto` e OBRIGATORIO no caso
// incorreto (400 se ausente) e ignorado no caso correto.
//
// Autorizacao na borda (US-21): requireAuthorizedUser -> 401/403. Acao auditada
// via logSensitiveAction. Escrita com service_role (tabelas de triagem fora das
// views lia.*, SEC-3).
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createEmbeddingProvider, EmbeddingError } from "../_shared/embeddings.ts";

const FUNCTION_SEGMENT = "automacao-feedback";

/** Texto-fonte do exemplo (objeto + verbatim) limitado para o embedding. */
const MAX_TEXTO_CHARS = 2_000;

// ---------------------------------------------------------------------
// Validacao do corpo (zod). rotulo_correto obrigatorio se feedback=incorreto.
// ---------------------------------------------------------------------

const vereditoEnum = z.enum(["lixo", "duvida", "util"]);

const feedbackBodySchema = z
  .object({
    aviso_id: z.string().uuid("aviso_id deve ser um uuid valido"),
    feedback: z.enum(["correto", "incorreto"]),
    rotulo_correto: vereditoEnum.nullish(),
  })
  .superRefine((val, ctx) => {
    if (
      val.feedback === "incorreto" &&
      (val.rotulo_correto === null || val.rotulo_correto === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rotulo_correto"],
        message: "rotulo_correto e obrigatorio quando feedback = incorreto",
      });
    }
  });

type FeedbackBody = z.infer<typeof feedbackBodySchema>;

interface AvisoRow {
  id: string;
  objeto: string | null;
  conteudo_verbatim: string | null;
  triagem_veredito: string | null;
}

interface DecisaoRow {
  id: string;
  veredito: string;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Gera o embedding do texto do exemplo (1024-d) reusando o provider plugavel da
 * ingestao. Best-effort: em degradacao (provider ausente/indisponivel) retorna
 * null e o exemplo e gravado sem embedding, sem derrubar o feedback.
 */
async function embedExemplo(texto: string): Promise<string | null> {
  if (!(getEnv().embeddingsEndpoint ?? "").trim()) return null;
  try {
    const provider = createEmbeddingProvider();
    const [vector] = await provider.embed([texto]);
    if (!Array.isArray(vector) || vector.length === 0) return null;
    return `[${vector.join(",")}]`;
  } catch (err) {
    if (err instanceof EmbeddingError) {
      console.warn(
        `[automacao-feedback] embeddings indisponiveis; exemplo sem vetor: ${err.message}`,
      );
      return null;
    }
    throw err;
  }
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao na borda: 401 sem sessao, 403 fora da allowlist.
    const ctx = await requireAuthorizedUser(req);

    const body: FeedbackBody = await parseJsonBody(req, feedbackBodySchema);
    const db = createServiceClient();

    // 1) Aviso + veredito vigente (404 quando inexistente ou nao triado).
    const { data: avisoRaw, error: avisoErr } = await db
      .from("avisos")
      .select("id, objeto, conteudo_verbatim, triagem_veredito")
      .eq("id", body.aviso_id)
      .maybeSingle();
    if (avisoErr) {
      throw new Error(`falha ao consultar o aviso: ${avisoErr.message}`);
    }
    const aviso = avisoRaw as AvisoRow | null;
    if (!aviso || aviso.triagem_veredito == null) {
      throw new HttpError(404, "sem_veredito_vigente", "aviso sem veredito vigente");
    }

    // 2) Decisao VIGENTE (ultima do aviso). Sem decisao -> 404.
    const { data: decisaoRaw, error: decErr } = await db
      .from("triagem_decisoes")
      .select("id, veredito")
      .eq("aviso_id", aviso.id)
      .order("decidido_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (decErr) {
      throw new Error(`falha ao consultar a decisao vigente: ${decErr.message}`);
    }
    const decisao = decisaoRaw as DecisaoRow | null;
    if (!decisao) {
      throw new HttpError(404, "sem_veredito_vigente", "aviso sem veredito vigente");
    }

    const vereditoAvaliado = decisao.veredito;
    const vereditoRotulado = body.feedback === "incorreto"
      ? (body.rotulo_correto as string)
      : vereditoAvaliado;

    const agora = new Date().toISOString();

    // 3) Atualiza o feedback humano na decisao vigente (idempotente: reavaliar
    //    sobrescreve quem/quando/feedback sem criar linha nova).
    const { error: upErr } = await db
      .from("triagem_decisoes")
      .update({
        feedback_humano: body.feedback,
        feedback_por: ctx.email,
        feedback_em: agora,
      })
      .eq("id", decisao.id);
    if (upErr) {
      throw new Error(`falha ao gravar feedback na decisao: ${upErr.message}`);
    }

    // 4) Substitui o exemplo associado a esta decisao (idempotencia por
    //    (aviso, veredito vigente)): apaga o(s) anterior(es) e insere um novo.
    const { error: delErr } = await db
      .from("triagem_exemplos")
      .delete()
      .eq("decisao_id", decisao.id);
    if (delErr) {
      throw new Error(`falha ao limpar exemplo anterior: ${delErr.message}`);
    }

    const texto = clip(
      `${aviso.objeto ?? ""}\n${aviso.conteudo_verbatim ?? ""}`.trim(),
      MAX_TEXTO_CHARS,
    );
    const embedding = await embedExemplo(texto);

    const { data: insExemplo, error: insErr } = await db
      .from("triagem_exemplos")
      .insert({
        aviso_id: aviso.id,
        decisao_id: decisao.id,
        texto,
        veredito_rotulado: vereditoRotulado,
        embedding,
        ativo: true,
      })
      .select("id")
      .single();
    if (insErr) {
      throw new Error(`falha ao gerar exemplo rotulado: ${insErr.message}`);
    }
    const exemploId = (insExemplo as { id: string }).id;

    // 5) Auditoria (sem conteudo sensivel: apenas ids/veredito/feedback).
    await logSensitiveAction({
      tabela: "triagem_decisoes",
      acao: "triagem_feedback",
      registroId: aviso.id,
      usuario: ctx.email,
      dadosNovos: {
        feedback_humano: body.feedback,
        veredito_avaliado: vereditoAvaliado,
        veredito_rotulado: vereditoRotulado,
        exemplo_id: exemploId,
        decisao_id: decisao.id,
      },
    });

    return jsonResponse(
      {
        aviso_id: aviso.id,
        feedback_humano: body.feedback,
        exemplo_id: exemploId,
        veredito_avaliado: vereditoAvaliado,
        veredito_rotulado: vereditoRotulado,
      },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
