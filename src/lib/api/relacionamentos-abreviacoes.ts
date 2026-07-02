// =====================================================================
// Wrapper fino de API para as abreviacoes e cores semanticas por tipo de no
// (config_tipos_no.abreviacao_padrao / cor_semantica) POR ORG (F4).
// Caminho da Edge: /relacionamentos-abreviacoes
//
// Endpoints consumidos:
//   GET   /relacionamentos-abreviacoes   { tipos: [{ tipo, abreviacao_padrao,
//                                          cor_semantica, cor? }] } (read-only,
//                                          consumido pela legenda do grafo)
//   PATCH /relacionamentos-abreviacoes   { itens: [...] } -> lote atomico;
//                                          200 { tipos, alterados }
//
// Respostas e payloads permanecem em snake_case.
// =====================================================================

import { apiFetch } from "@/lib/api/client";
import type {
  AbreviacoesPatchInput,
  AbreviacoesPatchResponse,
  AbreviacoesResponse,
} from "@/lib/api/relacionamentos-types";

const PATH = "relacionamentos-abreviacoes";

/** Lista as abreviacoes/cores semanticas por tipo da org (read-only). */
export function getRelacionamentosAbreviacoes(): Promise<AbreviacoesResponse> {
  return apiFetch<AbreviacoesResponse>(PATH, { method: "GET" });
}

/** Aplica um lote atomico de alteracoes de abreviacao/cor por tipo. */
export function patchRelacionamentosAbreviacoes(
  input: AbreviacoesPatchInput,
): Promise<AbreviacoesPatchResponse> {
  return apiFetch<AbreviacoesPatchResponse>(PATH, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
