import { apiFetch } from "@/lib/api/client";
import type { ConfigEmpresa } from "@/lib/api/types";

// ---------------------------------------------------------------------
// config_empresa — dados institucionais da DLH (singleton) para o
// cabecalho/rodape da Tabela de Precos em PDF. GET hidrata a tela;
// PUT persiste (camelCase no body; o Edge mapeia para snake_case).
// ---------------------------------------------------------------------

export function getConfigEmpresa(): Promise<ConfigEmpresa> {
  return apiFetch<ConfigEmpresa>("config-empresa", { method: "GET" });
}

export function updateConfigEmpresa(
  input: ConfigEmpresa,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("config-empresa", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
