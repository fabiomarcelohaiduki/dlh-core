// =====================================================================
// Edge Function: relacionamentos-feedback
//
// POST /functions/v1/relacionamentos-feedback
//
// Registra a acao humana INLINE sobre uma aresta do grafo de
// Relacionamentos (public.relacoes), na V2 em que o workflow de
// aprovacao foi abandonado: toda aresta nasce visivel e a revisao humana
// serve para registrar "ja vi" (visto) e sinalizar "esta errada"
// (incorreta).
//
// Contrato:
//   Request  { aresta_id: uuid, acao: 'visto'|'incorreta', motivo? }
//   Response 200 { aresta_id, visto_por, visto_em, incorreta,
//                  incorreta_motivo, updated_at }
//            404 aresta inexistente
//            422 motivo ausente na MARCACAO de incorreta
//
// Semantica dos toggles (idempotencia por estado - RNF-06):
//   * 'visto': se visto_em IS NULL -> seta visto_por (autor do JWT) e
//     visto_em; senao LIMPA ambos (desmarcar). Nunca exige motivo.
//   * 'incorreta': se incorreta=false -> EXIGE motivo (422 se ausente),
//     seta incorreta=true + incorreta_motivo=motivo. Se incorreta=true ->
//     re-clique zera incorreta=false + incorreta_motivo=NULL, SEM exigir
//     motivo.
//
// SEC-D2: o autor (visto_por) NUNCA vem do body; e sempre derivado do JWT
// via requireAuthorizedUser. O schema `.strict()` rejeita qualquer campo
// extra no corpo.
//
// Borda padrao (defense in depth junto a RLS):
//   handleCorsPreflight -> assertMethod POST (405) -> requireAuthorizedUser
//   (401/403) -> parseJsonBody zod -> service_role para a escrita ->
//   logSensitiveAction -> jsonResponse. errorResponse padrao via _shared.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  parseJsonBody,
  type RelacionamentosFeedbackInput,
  relacionamentosFeedbackSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-feedback";

/** Colunas de feedback lidas/retornadas da aresta. */
const ARESTA_FEEDBACK_COLUMNS = "id, visto_por, visto_em, incorreta, incorreta_motivo, updated_at";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Estado de feedback de uma aresta em public.relacoes. */
interface ArestaFeedbackRow {
  id: string;
  visto_por: string | null;
  visto_em: string | null;
  incorreta: boolean;
  incorreta_motivo: string | null;
  updated_at: string;
}

/** Resposta serializada da Edge (sem o campo interno `id`). */
interface FeedbackResponse {
  aresta_id: string;
  visto_por: string | null;
  visto_em: string | null;
  incorreta: boolean;
  incorreta_motivo: string | null;
  updated_at: string;
}

// ---------------------------------------------------------------------
// Carrega o estado atual da aresta (404 se inexistente).
// ---------------------------------------------------------------------
async function carregarAresta(db: ServiceClient, arestaId: string): Promise<ArestaFeedbackRow> {
  const { data, error } = await db
    .from("relacoes")
    .select(ARESTA_FEEDBACK_COLUMNS)
    .eq("id", arestaId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "aresta_query_failed", "falha ao consultar a aresta");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "aresta nao encontrada");
  }
  return data as ArestaFeedbackRow;
}

// ---------------------------------------------------------------------
// Deriva o patch de escrita a partir da acao + estado atual.
// Puro: nao faz I/O. Lanca 422 quando motivo e obrigatorio e ausente.
// ---------------------------------------------------------------------
function derivarPatch(
  input: RelacionamentosFeedbackInput,
  atual: ArestaFeedbackRow,
  autor: string,
): { patch: Record<string, unknown>; acaoAudit: string } {
  if (input.acao === "visto") {
    const jaVisto = atual.visto_em !== null;
    // Toggle: marca (autor + timestamp) quando ainda nao visto; senao limpa.
    const patch = jaVisto
      ? { visto_por: null, visto_em: null }
      : { visto_por: autor, visto_em: new Date().toISOString() };
    return { patch, acaoAudit: "relacionamento_visto" };
  }

  // acao === 'incorreta' (toggle reversivel).
  if (atual.incorreta === false) {
    // MARCACAO: motivo obrigatorio (422 quando ausente/vazio).
    const motivo = input.motivo?.trim() ?? "";
    if (motivo === "") {
      throw new HttpError(
        422,
        "motivo_obrigatorio",
        "motivo e obrigatorio ao marcar uma aresta como incorreta",
      );
    }
    return {
      patch: { incorreta: true, incorreta_motivo: motivo },
      acaoAudit: "relacionamento_incorreta",
    };
  }

  // DESMARCACAO: reverte sem exigir motivo.
  return {
    patch: { incorreta: false, incorreta_motivo: null },
    acaoAudit: "relacionamento_incorreta",
  };
}

// ---------------------------------------------------------------------
// Handler principal.
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    const ctx = await requireAuthorizedUser(req);
    const input = await parseJsonBody(req, relacionamentosFeedbackSchema);

    const db = createServiceClient();
    const atual = await carregarAresta(db, input.aresta_id);

    const { patch, acaoAudit } = derivarPatch(input, atual, ctx.email);

    const { data, error } = await db
      .from("relacoes")
      .update(patch)
      .eq("id", input.aresta_id)
      .select(ARESTA_FEEDBACK_COLUMNS)
      .maybeSingle();

    if (error) {
      throw new HttpError(500, "aresta_update_failed", "falha ao registrar o feedback na aresta");
    }
    if (!data) {
      // Aresta removida na corrida entre o SELECT e o UPDATE.
      throw new HttpError(404, "nao_encontrado", "aresta nao encontrada");
    }

    const atualizada = data as ArestaFeedbackRow;

    // Auditoria best-effort (nao derruba o fluxo em caso de falha).
    await logSensitiveAction({
      tabela: "relacoes",
      acao: acaoAudit,
      registroId: input.aresta_id,
      usuario: ctx.email,
      dadosAnteriores: {
        visto_por: atual.visto_por,
        visto_em: atual.visto_em,
        incorreta: atual.incorreta,
        incorreta_motivo: atual.incorreta_motivo,
      },
      dadosNovos: {
        visto_por: atualizada.visto_por,
        visto_em: atualizada.visto_em,
        incorreta: atualizada.incorreta,
        incorreta_motivo: atualizada.incorreta_motivo,
      },
    });

    const resposta: FeedbackResponse = {
      aresta_id: atualizada.id,
      visto_por: atualizada.visto_por,
      visto_em: atualizada.visto_em,
      incorreta: atualizada.incorreta,
      incorreta_motivo: atualizada.incorreta_motivo,
      updated_at: atualizada.updated_at,
    };

    return jsonResponse(resposta, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
