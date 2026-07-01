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

import { apiFetch } from "@/lib/api/client";
import type { PanoramaResponse } from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const PATH = "relacionamentos-panorama";

// ---------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------

/**
 * Le o panorama atual de relacionamentos da org. Aplica o cap_panorama da
 * config; quando excedido, devolve `truncado: true` com o subconjunto
 * truncado (ate `cap` nos).
 */
export function getRelacionamentosPanorama(): Promise<PanoramaResponse> {
  return apiFetch<PanoramaResponse>(PATH, { method: "GET" });
}
