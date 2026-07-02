// =====================================================================
// Wrapper fino de API para o backfill/reprocessamento de relacionamentos.
// Caminho da Edge:
//   /relacionamentos-backfill       (POST - cron ou humano autorizado)
//
// Retorna um BackfillResultado com contadores e o id da execucao criada.
// Disparos concorrentes retornam 409 (single-flight). O botao manual
// "Reprocessar" do grafo usa o MESMO endpoint (sessao humana autorizada).
// =====================================================================

import { apiFetch } from "@/lib/api/client";
import type { BackfillResultado } from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const BACKFILL_PATH = "relacionamentos-backfill";

// ---------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------

/**
 * Dispara o backfill completo (3 fases: estrutural, regras ativas, triagem).
 * Disparo concorrente retorna 409 (single-flight). Pode ser chamado via cron
 * (header X-Cron-Secret) ou via sessao humana autorizada.
 */
export function dispararRelacionamentosBackfill(): Promise<BackfillResultado> {
  return apiFetch<BackfillResultado>(BACKFILL_PATH, {
    method: "POST",
  });
}

/**
 * Reprocessa a teia de relacionamentos (botao manual). Mesmo endpoint do
 * backfill (exige sessao humana autorizada). Usado no grafo para forcar
 * uma nova passagem do backfill.
 */
export function reprocessarRelacionamentos(): Promise<BackfillResultado> {
  return apiFetch<BackfillResultado>(BACKFILL_PATH, {
    method: "POST",
  });
}
