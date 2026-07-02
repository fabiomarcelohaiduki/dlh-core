"use client";

// =====================================================================
// Hooks da feature "Relacionamentos" - abreviacoes e cores semanticas (F4).
//
//   useRelacionamentosAbreviacoes - GET (legenda do grafo + editor humano)
//   useEditarAbreviacoes          - PATCH lote atomico
//
// Ao salvar o lote, o PATCH invalida:
//   - relacionamentosLeituraKeys.abreviacoes()   (a legenda le a versao nova)
//   - relacionamentosLeituraKeys.panoramaPrefix  (os nos do grafo herdam a
//     nova abreviacao/cor na proxima leitura; propagacao nao e realtime)
//   - relacionamentosConfigKeys.tipos()          (a metadata dos tipos mudou)
// =====================================================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getRelacionamentosAbreviacoes,
  patchRelacionamentosAbreviacoes,
} from "@/lib/api/relacionamentos-abreviacoes";
import type { AbreviacoesPatchInput } from "@/lib/api/relacionamentos-types";
import { relacionamentosLeituraKeys } from "./use-relacionamentos-leitura";
import { relacionamentosConfigKeys } from "./use-relacionamentos-config";

/** useRelacionamentosAbreviacoes - GET /relacionamentos-abreviacoes. */
export function useRelacionamentosAbreviacoes() {
  return useQuery({
    queryKey: relacionamentosLeituraKeys.abreviacoes(),
    queryFn: () => getRelacionamentosAbreviacoes(),
  });
}

/**
 * useEditarAbreviacoes - PATCH /relacionamentos-abreviacoes (lote atomico).
 * Invalida a legenda, o panorama (propagacao no proximo read) e os tipos.
 */
export function useEditarAbreviacoes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AbreviacoesPatchInput) => patchRelacionamentosAbreviacoes(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosLeituraKeys.abreviacoes() });
      queryClient.invalidateQueries({ queryKey: relacionamentosLeituraKeys.panoramaPrefix });
      queryClient.invalidateQueries({ queryKey: relacionamentosConfigKeys.tipos() });
    },
  });
}
