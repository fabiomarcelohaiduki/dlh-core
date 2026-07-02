// =====================================================================
// Wrapper fino de API para o feedback inline de arestas do grafo de
// Relacionamentos.
//
// Edge: POST /functions/v1/relacionamentos-feedback
//   Request  { aresta_id, acao: 'visto'|'incorreta', motivo? }
//   Response { aresta_id, visto_por, visto_em, incorreta,
//              incorreta_motivo, updated_at }
//
// Ao contrario das demais leituras (que passam pelo proxy /proxy), o
// feedback usa `supabase.functions.invoke`, que anexa o Bearer da sessao
// do usuario autenticado ao chamar a Edge Function.
// =====================================================================

import { createClient } from "@/lib/supabase/client";
import type {
  ArestaFeedbackInput,
  ArestaFeedbackResponse,
} from "@/lib/api/relacionamentos-types";

/**
 * Registra uma acao de feedback inline sobre uma aresta.
 *
 * `visto` e um toggle idempotente por estado; `incorreta` e um toggle
 * reversivel que exige `motivo` apenas na marcacao (o backend valida e
 * devolve 422 quando ausente).
 */
export async function marcarArestaFeedback(
  body: ArestaFeedbackInput,
): Promise<ArestaFeedbackResponse> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke<ArestaFeedbackResponse>(
    "relacionamentos-feedback",
    { body },
  );

  if (error) throw error;
  if (!data) {
    throw new Error("resposta vazia da Edge relacionamentos-feedback");
  }
  return data;
}
