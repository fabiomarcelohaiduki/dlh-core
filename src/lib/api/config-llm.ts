import { apiFetch } from "@/lib/api/client";
import type { ConfigLlm, ConfigLlmInput } from "@/lib/api/types";

// ---------------------------------------------------------------------
// config_llm — configuracao da IA (LLM) das geracoes assistidas (singleton).
// GET hidrata a tela (key_configurada sinaliza chave no Vault, nunca o
// segredo); PUT persiste provider/modelo/ativo e, se apiKey vier, grava a
// chave CIFRADA no Vault (o Edge nao a devolve).
// ---------------------------------------------------------------------

export function getConfigLlm(): Promise<ConfigLlm> {
  return apiFetch<ConfigLlm>("config-llm", { method: "GET" });
}

export function updateConfigLlm(
  input: ConfigLlmInput,
): Promise<{ ok: boolean; key_configurada: boolean }> {
  return apiFetch<{ ok: boolean; key_configurada: boolean }>("config-llm", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
