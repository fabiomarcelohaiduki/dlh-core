// =====================================================================
// Wrapper fino de API para a leitura do panorama de relacionamentos.
// Caminho da Edge: /relacionamentos-panorama
//
// Endpoints consumidos:
//   GET /relacionamentos-panorama   retorna nos + arestas com cap aplicado
//                                   e flag `truncado` quando o cap e excedido
//
// Respostas e payloads permanecem em snake_case (campos do JSON).
// =====================================================================

import { apiFetch, buildQuery } from "@/lib/api/client";
import type {
  PanoramaParams,
  PanoramaResponse,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const PATH = "relacionamentos-panorama";

// ---------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------

/**
 * Le o panorama de UM dos dois grafos de relacionamentos (V2). Envia:
 *   - tipo         (hierarquico|semantico) - omitido => default da org
 *   - no_id        (uuid) - ancora o panorama e devolve a vizinhanca
 *   - profundidade (int)  - profundidade da vizinhanca ancorada [0..5]
 *
 * Aplica o cap por grafo (cap_por_grafo ?? 200); quando
 * excedido, devolve `truncado: true` com o subconjunto truncado.
 */
export function getRelacionamentosPanorama(
  params: PanoramaParams = {},
): Promise<PanoramaResponse> {
  const query = buildQuery({
    tipo: params.tipo,
    no_id: params.no_id ?? undefined,
    profundidade: params.profundidade ?? undefined,
  });
  return apiFetch<PanoramaResponse>(`${PATH}${query}`, { method: "GET" });
}
