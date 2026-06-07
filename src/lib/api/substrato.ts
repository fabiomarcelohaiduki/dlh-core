import { apiFetch } from "@/lib/api/client";
import type { AvisoDetalhe, ReprocessarResponse } from "@/lib/api/types";

/**
 * GET /substrato/avisos/:id — detalhe completo do aviso (substrato-aviso).
 * Unica superficie humana de acesso a um edital: verbatim, payload bruto
 * integral e estado de indexacao. id invalido/inexistente -> 404 (ApiError).
 */
export function fetchAvisoDetalhe(
  avisoId: string,
  signal?: AbortSignal,
): Promise<AvisoDetalhe> {
  return apiFetch<AvisoDetalhe>(`substrato-aviso/${encodeURIComponent(avisoId)}`, {
    method: "GET",
    signal,
  });
}

/**
 * POST /substrato/avisos/:id/reindexar — reprocessa um unico item
 * (substrato-reindexar). O backend marca status_reprocesso='em_andamento'
 * para o item, prevenindo disparo duplicado; retorna o status do reprocesso.
 */
export function reprocessarAviso(avisoId: string): Promise<ReprocessarResponse> {
  return apiFetch<ReprocessarResponse>(
    `substrato-reindexar/${encodeURIComponent(avisoId)}`,
    { method: "POST" },
  );
}
