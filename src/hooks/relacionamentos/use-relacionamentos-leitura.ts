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
  PanoramaParams,
  RelacionamentosVizinhancaInput,
  RelacionamentoTipoGrafo,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Chaves de cache de leitura (panorama, vizinhanca) e reprocessamento.
// ---------------------------------------------------------------------

export const relacionamentosLeituraKeys = {
  all: ["relacionamentos-leitura"] as QueryKey,
  /**
   * Prefixo de TODAS as fotografias de panorama (qualquer tipo/ancora/
   * profundidade). Usado como filtro para invalidar/patchar o panorama sem
   * saber a combinacao exata (ex.: feedback inline de arestas).
   */
  panoramaPrefix: ["relacionamentos-leitura", "panorama"] as QueryKey,
  /**
   * Panorama chaveado por (tipo, noId, profundidade). Cada combinacao e uma
   * fotografia distinta de UM dos dois grafos (V2), com cache independente.
   */
  panorama: (
    tipo: RelacionamentoTipoGrafo | undefined,
    noId: string | null | undefined,
    profundidade: number | null | undefined,
  ): QueryKey => [
    "relacionamentos-leitura",
    "panorama",
    tipo ?? "default",
    noId ?? null,
    profundidade ?? null,
  ],
  vizinhanca: (input: RelacionamentosVizinhancaInput): QueryKey => [
    "relacionamentos-leitura",
    "vizinhanca",
    input.tipo,
    input.id,
    input.profundidade ?? null,
  ],
  /**
   * Regras semanticas (2 blocos: candidatos keyset + ajustes render-only).
   * A key carrega apenas o limite; o cursor de cada pagina vive nos pageParams
   * do useInfiniteQuery, mantendo o cache unico por limite.
   */
  regrasSemanticas: (limite?: number | null): QueryKey => [
    "relacionamentos-leitura",
    "regras-semanticas",
    limite ?? null,
  ],
  /** Abreviacoes/cores semanticas por tipo (legenda + editor). */
  abreviacoes: (): QueryKey => ["relacionamentos-leitura", "abreviacoes"],
};

// ---------------------------------------------------------------------
// Hooks de leitura
// ---------------------------------------------------------------------

/**
 * useRelacionamentosPanorama - GET /relacionamentos-panorama?tipo=&no_id=&profundidade=
 *
 * Carrega SEMPRE um subgrafo por (tipo, ancora?, profundidade), nunca o
 * panorama completo. A query key inclui os tres eixos para isolar o cache
 * de cada fotografia (toggle Hierarquico/Semantico, ancora e profundidade).
 */
export function useRelacionamentosPanorama(params: PanoramaParams = {}) {
  const { tipo, no_id, profundidade } = params;
  return useQuery({
    queryKey: relacionamentosLeituraKeys.panorama(tipo, no_id, profundidade),
    queryFn: () => getRelacionamentosPanorama({ tipo, no_id, profundidade }),
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

/** useReprocessarRelacionamentos - POST /relacionamentos-backfill (disparo manual). */
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
