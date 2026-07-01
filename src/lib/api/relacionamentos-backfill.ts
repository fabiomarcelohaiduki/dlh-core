// =====================================================================
// Wrapper fino de API para o backfill/reprocessamento de relacionamentos.
// Caminhos das Edges:
//   /relacionamentos-backfill       (POST - cron ou humano autorizado)
//   /relacionamentos-reprocessar    (POST - humano autorizado, mesmo handler)
//
// Ambos retornam um BackfillResultado com contadores e o id da execucao
// criada. Disparos concorrentes retornam 409 (single-flight).
// =====================================================================

import { apiFetch } from "@/lib/api/client";
import type { BackfillResultado } from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const BACKFILL_PATH = "relacionamentos-backfill";
const REPROCESSAR_PATH = "relacionamentos-reprocessar";

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
 * Reprocessa a teia de relacionamentos (botao manual). Mesmo handler do
 * backfill, mas exige sessao humana autorizada. Usado na sub-aba
 * "Aprovacoes pendentes" para forcar uma nova passagem do backfill.
 */
export function reprocessarRelacionamentos(): Promise<BackfillResultado> {
  return apiFetch<BackfillResultado>(REPROCESSAR_PATH, {
    method: "POST",
  });
}
