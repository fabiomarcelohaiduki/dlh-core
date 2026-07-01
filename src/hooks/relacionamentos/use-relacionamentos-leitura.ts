"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { getRelacionamentosPanorama } from "@/lib/api/relacionamentos-panorama";
import { getRelacionamentosVizinhanca } from "@/lib/api/relacionamentos-vizinhanca";
import {
  dispararRelacionamentosBackfill,
  reprocessarRelacionamentos,
} from "@/lib/api/relacionamentos-backfill";
import type {
  RelacionamentosVizinhancaInput,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Chaves de cache de leitura (panorama, vizinhanca) e reprocessamento.
// ---------------------------------------------------------------------

export const relacionamentosLeituraKeys = {
  all: ["relacionamentos-leitura"] as QueryKey,
  panorama: () => ["relacionamentos-leitura", "panorama"] as QueryKey,
  vizinhanca: (input: RelacionamentosVizinhancaInput): QueryKey => [
    "relacionamentos-leitura",
    "vizinhanca",
    input.tipo,
    input.id,
    input.profundidade ?? null,
  ],
};

// ---------------------------------------------------------------------
// Hooks de leitura
// ---------------------------------------------------------------------

/** useRelacionamentosPanorama - GET /relacionamentos-panorama. */
export function useRelacionamentosPanorama() {
  return useQuery({
    queryKey: relacionamentosLeituraKeys.panorama(),
    queryFn: () => getRelacionamentosPanorama(),
  });
}

/** useRelacionamentosVizinhanca - POST /relacionamentos-vizinhanca. */
export function useRelacionamentosVizinhanca(input: RelacionamentosVizinhancaInput | null) {
  return useQuery({
    queryKey: relacionamentosLeituraKeys.vizinhanca(
      input ?? { tipo: "aviso", id: "-", profundidade: 0 },
    ),
    queryFn: () => getRelacionamentosVizinhanca(input as RelacionamentosVizinhancaInput),
    enabled: Boolean(input && input.tipo && input.id),
  });
}

// ---------------------------------------------------------------------
// Hooks de reprocessamento (mutacoes)
//
// Disparar/reprocessar invalidam o panorama e a vizinhanca (a teia pode
// mudar) e o catalogo de regras (se uma regra nova for cascateada).
// ---------------------------------------------------------------------

/** useDispararRelacionamentosBackfill - POST /relacionamentos-backfill. */
export function useDispararRelacionamentosBackfill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dispararRelacionamentosBackfill(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosLeituraKeys.all });
      queryClient.invalidateQueries({ queryKey: ["relacionamentos-regras"] });
      queryClient.invalidateQueries({ queryKey: ["relacionamentos-vinculos-lia"] });
    },
  });
}

/** useReprocessarRelacionamentos - POST /relacionamentos-reprocessar. */
export function useReprocessarRelacionamentos() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => reprocessarRelacionamentos(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosLeituraKeys.all });
      queryClient.invalidateQueries({ queryKey: ["relacionamentos-regras"] });
      queryClient.invalidateQueries({ queryKey: ["relacionamentos-vinculos-lia"] });
    },
  });
}
