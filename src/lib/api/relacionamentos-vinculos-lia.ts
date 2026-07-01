// =====================================================================
// Wrapper fino de API para vinculos inferidos pela Lia (vinculos_inferidos_lia).
// Caminho da Edge: /relacionamentos-vinculos-lia
//
// Endpoints consumidos:
//   GET    /relacionamentos-vinculos-lia              listar (filtro ?status=&origem=)
//   GET    /relacionamentos-vinculos-lia/:id          obter 1 vinculo
//   POST   /relacionamentos-vinculos-lia              criar (humano ou Lia)
//   PUT    /relacionamentos-vinculos-lia/:id          editar (parcial)
//   DELETE /relacionamentos-vinculos-lia/:id          remover
//   POST   /relacionamentos-vinculos-lia/decidir      aprovar / rejeitar / editar
//                                                     (motivo obrigatorio exceto aprovar)
//
// Respostas e payloads permanecem em snake_case.
// =====================================================================

import { apiFetch, buildQuery } from "@/lib/api/client";
import type {
  ListRelacionamentosVinculosParams,
  RelacionamentoPaginated,
  VinculoLia,
  VinculoLiaCreateInput,
  VinculoLiaDecidirInput,
  VinculoLiaUpdateInput,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const PATH = "relacionamentos-vinculos-lia";

// ---------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------

/** Lista vinculos inferidos pela Lia (filtro ?status=&origem=&limit=&offset=). */
export function listRelacionamentosVinculosLia(
  params: ListRelacionamentosVinculosParams = {},
): Promise<RelacionamentoPaginated<VinculoLia>> {
  const { status, origem, limit, offset } = params;
  return apiFetch<RelacionamentoPaginated<VinculoLia>>(
    `${PATH}${buildQuery({ status, origem, limit, offset })}`,
    { method: "GET" },
  );
}

/** Obtem 1 vinculo por id. */
export function getRelacionamentosVinculoLia(id: string): Promise<VinculoLia> {
  return apiFetch<VinculoLia>(`${PATH}/${id}`, { method: "GET" });
}

/** Cria um vinculo inferido (origem='humano' para ajuste manual). */
export function createRelacionamentosVinculoLia(
  input: VinculoLiaCreateInput,
): Promise<VinculoLia> {
  return apiFetch<VinculoLia>(PATH, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Edita um vinculo (parcial). */
export function updateRelacionamentosVinculoLia(
  id: string,
  input: VinculoLiaUpdateInput,
): Promise<VinculoLia> {
  return apiFetch<VinculoLia>(`${PATH}/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** Remove um vinculo. */
export function deleteRelacionamentosVinculoLia(
  id: string,
): Promise<{ ok: boolean; id: string }> {
  return apiFetch<{ ok: boolean; id: string }>(`${PATH}/${id}`, { method: "DELETE" });
}

/** Decide um vinculo (aprovar / rejeitar / editar). */
export function decidirRelacionamentosVinculoLia(
  input: VinculoLiaDecidirInput,
): Promise<{ ok: boolean; regra_id?: string; vinculo_id: string; status: string }> {
  return apiFetch<{ ok: boolean; regra_id?: string; vinculo_id: string; status: string }>(
    `${PATH}/decidir`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
