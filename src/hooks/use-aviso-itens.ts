"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { getAvisoItens } from "@/lib/api/automacao";

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
