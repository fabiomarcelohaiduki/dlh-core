// =====================================================================
// Wrapper fino de API para a config da org (config_relacionamentos).
// Caminho da Edge: /relacionamentos-config
//
// Endpoints consumidos:
//   GET /relacionamentos-config    config singleton (cria com defaults se nao existir)
//   PUT /relacionamentos-config    atualizar (parcial)
//
// A gestao dos tipos de no mora em relacionamentos-tipos-no.ts.
// Respostas e payloads permanecem em snake_case.
// =====================================================================

import { apiFetch } from "@/lib/api/client";
import type {
  ConfigRelacionamentos,
  ConfigRelacionamentosUpdateInput,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const PATH = "relacionamentos-config";

// ---------------------------------------------------------------------
// API publica - config singleton
// ---------------------------------------------------------------------

/** Le a config singleton da org (cria com defaults se nao existir). */
export function getRelacionamentosConfig(): Promise<ConfigRelacionamentos> {
  return apiFetch<ConfigRelacionamentos>(PATH, { method: "GET" });
}

/** Atualiza a config (parcial). */
export function updateRelacionamentosConfig(
  input: ConfigRelacionamentosUpdateInput,
): Promise<ConfigRelacionamentos> {
  return apiFetch<ConfigRelacionamentos>(PATH, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
