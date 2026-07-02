// =====================================================================
// Wrapper fino de API para as regras semanticas da org (F4).
// Caminho da Edge: /relacionamentos-regras-semanticas
//
// 2 blocos:
//   - candidatos           -> vinculos_inferidos_lia auditaveis (ativar/
//                             desativar). Paginacao KEYSET (cursor opaco).
//   - ajustes_tecnicos_lia -> config_relacionamentos RENDER-ONLY (RNF-15).
//
// Endpoints consumidos:
//   GET  /relacionamentos-regras-semanticas?cursor=&limite=
//        -> { candidatos, nextCursor, limite, ajustes_tecnicos_lia }
//   POST /relacionamentos-regras-semanticas  { bloco, operacao, item_id?, motivo? }
//        -> 200 devolve os 2 blocos (primeira pagina) apos a mutacao.
//
// Respostas e payloads permanecem em snake_case.
// =====================================================================

import { apiFetch, buildQuery } from "@/lib/api/client";
import type {
  RegraSemanticaAcaoInput,
  RegrasSemanticasParams,
  RegrasSemanticasResponse,
} from "@/lib/api/relacionamentos-types";

const PATH = "relacionamentos-regras-semanticas";

/** Le uma pagina keyset de candidatos + o bloco render-only de ajustes. */
export function getRelacionamentosRegrasSemanticas(
  params: RegrasSemanticasParams = {},
): Promise<RegrasSemanticasResponse> {
  const qs = buildQuery({ cursor: params.cursor, limite: params.limite });
  return apiFetch<RegrasSemanticasResponse>(`${PATH}${qs}`, { method: "GET" });
}

/**
 * Aplica uma acao sobre um bloco. Somente `candidatos` e mutavel
 * (ativar/desativar); `ajustes_tecnicos` retorna 403 (render-only).
 * Retorna os 2 blocos frescos (primeira pagina).
 */
export function acaoRelacionamentosRegraSemantica(
  input: RegraSemanticaAcaoInput,
): Promise<RegrasSemanticasResponse> {
  return apiFetch<RegrasSemanticasResponse>(PATH, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
