"use client";

import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { coletarItensPortal, getAvisoItens } from "@/lib/api/automacao";

/** Chaves de cache dos itens extraidos por aviso (expansao da linha). */
export const avisoItensKeys = {
  all: ["aviso-itens"] as QueryKey,
  byAviso: (avisoId: string): QueryKey => ["aviso-itens", avisoId],
};

/**
 * useAvisoItens — documentos + itens extraidos de um aviso (recall por item).
 * Busca LAZY: so dispara quando `enabled` (linha expandida). Sem refetch
 * automatico — a extracao e da Lia, em rajadas; o usuario reabre para atualizar.
 */
export function useAvisoItens(avisoId: string, enabled: boolean) {
  return useQuery({
    queryKey: avisoItensKeys.byAviso(avisoId),
    queryFn: () => getAvisoItens(avisoId),
    enabled,
  });
}

/**
 * useColetarItensPortal — dispara a coleta da lista completa do painel Effecti
 * (/all) e invalida os itens do aviso para a lista recoletada reaparecer.
 * Standalone, fora da triagem.
 */
export function useColetarItensPortal(avisoId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (effectiId: string) => coletarItensPortal(effectiId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: avisoItensKeys.byAviso(avisoId) });
    },
  });
}
