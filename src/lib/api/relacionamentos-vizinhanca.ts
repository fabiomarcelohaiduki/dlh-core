// =====================================================================
// Wrapper fino de API para a travessia da teia de relacionamentos a partir
// de 1 no. Caminho da Edge: /relacionamentos-vizinhanca
//
// Endpoints consumidos:
//   POST /relacionamentos-vizinhanca   recebe { tipo, id, profundidade? }
//                                     retorna { no_ancora, nos[] } com
//                                     profundidade [0..5] (clampada no backend)
//                                     e cache em memoria por (org,tipo,id,profundidade)
//
// Payload de entrada em snake_case (espelho do validation backend).
// =====================================================================

import { apiFetch } from "@/lib/api/client";
import type {
  RelacionamentosVizinhancaInput,
  VizinhancaResponse,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const PATH = "relacionamentos-vizinhanca";

// ---------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------

/** Travessia a partir de 1 no (ancora) ate a profundidade informada. */
export function getRelacionamentosVizinhanca(
  input: RelacionamentosVizinhancaInput,
): Promise<VizinhancaResponse> {
  return apiFetch<VizinhancaResponse>(PATH, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
