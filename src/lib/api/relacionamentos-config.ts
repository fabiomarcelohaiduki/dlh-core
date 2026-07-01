// =====================================================================
// Wrapper fino de API para a config da org (config_relacionamentos + config_tipos_no).
// Caminho da Edge: /relacionamentos-config
//
// Endpoints consumidos:
//   GET    /relacionamentos-config             config singleton (cria com defaults se nao existir)
//   PUT    /relacionamentos-config             atualizar (parcial)
//   GET    /relacionamentos-config/tipos       lista config_tipos_no da org
//   POST   /relacionamentos-config/tipos       criar tipo
//   PUT    /relacionamentos-config/tipos       upsert/update (id OU tipo como chave)
//
// Respostas e payloads permanecem em snake_case.
// =====================================================================

import { apiFetch } from "@/lib/api/client";
import type {
  ConfigRelacionamentos,
  ConfigRelacionamentosUpdateInput,
  ConfigTipoNo,
  ConfigTipoNoCreateInput,
  ConfigTipoNoUpdateInput,
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

// ---------------------------------------------------------------------
// API publica - tipos de no
// ---------------------------------------------------------------------

/** Lista os tipos de no (config_tipos_no) da org. */
export function listRelacionamentosTipos(): Promise<{ items: ConfigTipoNo[] }> {
  return apiFetch<{ items: ConfigTipoNo[] }>(`${PATH}/tipos`, { method: "GET" });
}

/** Cria um tipo de no. */
export function createRelacionamentosTipo(input: ConfigTipoNoCreateInput): Promise<ConfigTipoNo> {
  return apiFetch<ConfigTipoNo>(`${PATH}/tipos`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Atualiza/upsert um tipo de no (id OU tipo como chave). */
export function updateRelacionamentosTipo(
  input: ConfigTipoNoUpdateInput,
): Promise<ConfigTipoNo> {
  return apiFetch<ConfigTipoNo>(`${PATH}/tipos`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
