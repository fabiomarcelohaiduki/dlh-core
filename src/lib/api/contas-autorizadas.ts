import { apiFetch, buildQuery } from "@/lib/api/client";
import type { ContaAutorizada, ContaAutorizadaInput } from "@/lib/api/types";

// ---------------------------------------------------------------------
// contas_autorizadas — allowlist de acesso do cockpit (US-21). Toda chamada
// passa pela Edge `contas-autorizadas` (RLS no escopo do usuario + auditoria).
// ---------------------------------------------------------------------

/** GET — lista todas as contas/dominios da allowlist. */
export async function listContasAutorizadas(): Promise<ContaAutorizada[]> {
  const res = await apiFetch<{ contas: ContaAutorizada[] }>("contas-autorizadas", {
    method: "GET",
  });
  return res.contas;
}

/** POST — cria uma entrada (e-mail ou dominio). */
export function createContaAutorizada(input: ContaAutorizadaInput): Promise<ContaAutorizada> {
  return apiFetch<ContaAutorizada>("contas-autorizadas", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** PATCH — liga/desliga uma entrada sem remove-la. */
export function toggleContaAutorizada(id: string, ativo: boolean): Promise<ContaAutorizada> {
  return apiFetch<ContaAutorizada>("contas-autorizadas", {
    method: "PATCH",
    body: JSON.stringify({ id, ativo }),
  });
}

/** DELETE — remove uma entrada da allowlist. */
export function deleteContaAutorizada(id: string): Promise<{ ok: boolean; id: string }> {
  return apiFetch<{ ok: boolean; id: string }>(`contas-autorizadas${buildQuery({ id })}`, {
    method: "DELETE",
  });
}
