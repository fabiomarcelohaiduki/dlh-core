"use client";

// =====================================================================
// use-contas-autorizadas — CRUD da allowlist de acesso do cockpit (US-21).
//
// Cada mutation chama a Edge `contas-autorizadas` (RLS + auditoria) e invalida
// o cache da lista. A trava anti-lockout vive no servidor: desativar/remover a
// unica entrada que autoriza o proprio solicitante volta 409 lockout_bloqueado.
// =====================================================================

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  createContaAutorizada,
  deleteContaAutorizada,
  listContasAutorizadas,
  toggleContaAutorizada,
} from "@/lib/api/contas-autorizadas";
import type { ContaAutorizadaInput } from "@/lib/api/types";

export const contasAutorizadasKeys = {
  all: ["contas-autorizadas"] as QueryKey,
};

/** Leitura da allowlist completa. */
export function useContasAutorizadas(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: contasAutorizadasKeys.all,
    queryFn: listContasAutorizadas,
    enabled: options?.enabled ?? true,
  });
}

/** Cria uma entrada (e-mail ou dominio). */
export function useCriarContaAutorizada() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ContaAutorizadaInput) => createContaAutorizada(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: contasAutorizadasKeys.all });
    },
  });
}

/** Liga/desliga uma entrada sem remove-la. */
export function useToggleContaAutorizada() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ativo }: { id: string; ativo: boolean }) =>
      toggleContaAutorizada(id, ativo),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: contasAutorizadasKeys.all });
    },
  });
}

/** Remove uma entrada da allowlist. */
export function useRemoverContaAutorizada() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteContaAutorizada(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: contasAutorizadasKeys.all });
    },
  });
}
