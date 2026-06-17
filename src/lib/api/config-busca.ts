import { apiFetch } from "@/lib/api/client";
import type { ConfigBusca, ConfigBuscaInput } from "@/lib/api/types";

// ---------------------------------------------------------------------
// config_busca — configuracao do RERANKING da busca semantica (singleton).
// GET hidrata a tela (key_configurada sinaliza chave da Cohere no Vault,
// nunca o segredo); PUT persiste rerankAtivo/rerankModelo/rerankCandidatos
// e, se apiKey vier, grava a chave CIFRADA no Vault (o Edge nao a devolve).
// ---------------------------------------------------------------------

export function getConfigBusca(): Promise<ConfigBusca> {
  return apiFetch<ConfigBusca>("config-busca", { method: "GET" });
}

export function updateConfigBusca(
  input: ConfigBuscaInput,
): Promise<{ ok: boolean; key_configurada: boolean }> {
  return apiFetch<{ ok: boolean; key_configurada: boolean }>("config-busca", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
