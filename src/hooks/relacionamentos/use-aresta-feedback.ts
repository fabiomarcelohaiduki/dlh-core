"use client";

// =====================================================================
// Hooks de feedback inline de arestas (F1).
//
// Substituem o antigo workflow de aprovacao: a aresta nasce OK e o humano
// apenas registra que ja viu (visto) ou sinaliza que esta errada
// (incorreta), inline na tabela de arestas.
//
// Ambos os hooks fazem OPTIMISTIC UPDATE sobre o cache do panorama
// (relacionamentosLeituraKeys.panorama), com ROLLBACK em caso de erro, e
// invalidam o panorama no settle. Sucesso dispara um toast verde PT-BR.
// =====================================================================

import {
  useMutation,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { marcarArestaFeedback } from "@/lib/api/relacionamentos-feedback";
import { useToast } from "@/components/ui/toast";
import type {
  ArestaVisual,
  PanoramaResponse,
} from "@/lib/api/relacionamentos-types";
import { relacionamentosLeituraKeys } from "./use-relacionamentos-leitura";

// ---------------------------------------------------------------------
// Helpers puros.
// ---------------------------------------------------------------------

/**
 * Snapshot para rollback. Como o panorama e chaveado por (tipo, ancora,
 * profundidade), a MESMA aresta pode viver em varias fotografias em cache;
 * guardamos todas para reverter cada uma no erro.
 */
type PanoramaSnapshot = ReadonlyArray<[QueryKey, PanoramaResponse | undefined]>;

interface FeedbackMutationContext {
  anterior: PanoramaSnapshot;
}

/** Aplica um patch imutavel na aresta identificada por id dentro do panorama. */
function patchArestaNoPanorama(
  prev: PanoramaResponse | undefined,
  arestaId: string,
  patch: Partial<ArestaVisual>,
): PanoramaResponse | undefined {
  if (!prev) return prev;
  return {
    ...prev,
    arestas: prev.arestas.map((a) =>
      a.id === arestaId ? { ...a, ...patch } : a,
    ),
  };
}

/**
 * Deriva o estado atual da aresta varrendo TODAS as fotografias em cache.
 * Retorna a primeira ocorrencia (o estado e o mesmo em todas as copias).
 */
function acharArestaNoCache(
  snapshots: PanoramaSnapshot,
  arestaId: string,
): ArestaVisual | undefined {
  for (const [, panorama] of snapshots) {
    const found = panorama?.arestas.find((a) => a.id === arestaId);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------
// useMarcarArestaVista - toggle "visto" com optimistic update.
// ---------------------------------------------------------------------

/**
 * Marca (ou desmarca) uma aresta como vista. Toggle idempotente por estado:
 * se ja vista, o re-clique limpa; senao, registra o autor + timestamp.
 */
export function useMarcarArestaVista(arestaId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const panoramaFilter = { queryKey: relacionamentosLeituraKeys.panoramaPrefix };

  return useMutation<
    Awaited<ReturnType<typeof marcarArestaFeedback>>,
    unknown,
    void,
    FeedbackMutationContext
  >({
    mutationFn: () => marcarArestaFeedback({ aresta_id: arestaId, acao: "visto" }),
    onMutate: async () => {
      await queryClient.cancelQueries(panoramaFilter);
      const anterior =
        queryClient.getQueriesData<PanoramaResponse>(panoramaFilter);
      const atual = acharArestaNoCache(anterior, arestaId);
      const jaVisto = Boolean(atual?.visto_em);
      queryClient.setQueriesData<PanoramaResponse | undefined>(
        panoramaFilter,
        (prev) =>
          patchArestaNoPanorama(
            prev,
            arestaId,
            jaVisto
              ? { visto_por: null, visto_em: null }
              : { visto_por: "voce", visto_em: new Date().toISOString() },
          ),
      );
      return { anterior };
    },
    onError: (_err, _vars, context) => {
      context?.anterior.forEach(([key, data]) => {
        queryClient.setQueryData(key, data);
      });
    },
    onSuccess: () => {
      toast({ title: "Visto registrado", variant: "ok" });
    },
    onSettled: () => {
      queryClient.invalidateQueries(panoramaFilter);
    },
  });
}

// ---------------------------------------------------------------------
// useSinalizarArestaIncorreta - toggle "incorreta" com optimistic update.
// ---------------------------------------------------------------------

/**
 * Sinaliza (ou reverte) uma aresta como incorreta. Na marcacao exige
 * `motivo` (auditado); a desmarcacao dispensa motivo. O toggle e derivado
 * do estado atual da aresta no cache do panorama.
 */
export function useSinalizarArestaIncorreta(arestaId: string, motivo?: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const panoramaFilter = { queryKey: relacionamentosLeituraKeys.panoramaPrefix };

  return useMutation<
    Awaited<ReturnType<typeof marcarArestaFeedback>>,
    unknown,
    void,
    FeedbackMutationContext
  >({
    mutationFn: () =>
      marcarArestaFeedback({ aresta_id: arestaId, acao: "incorreta", motivo }),
    onMutate: async () => {
      await queryClient.cancelQueries(panoramaFilter);
      const anterior =
        queryClient.getQueriesData<PanoramaResponse>(panoramaFilter);
      const atual = acharArestaNoCache(anterior, arestaId);
      const jaIncorreta = Boolean(atual?.incorreta);
      queryClient.setQueriesData<PanoramaResponse | undefined>(
        panoramaFilter,
        (prev) =>
          patchArestaNoPanorama(
            prev,
            arestaId,
            jaIncorreta
              ? { incorreta: false, incorreta_motivo: null }
              : { incorreta: true, incorreta_motivo: motivo ?? null },
          ),
      );
      return { anterior };
    },
    onError: (_err, _vars, context) => {
      context?.anterior.forEach(([key, data]) => {
        queryClient.setQueryData(key, data);
      });
    },
    onSuccess: () => {
      toast({ title: "Incorreta sinalizada", variant: "ok" });
    },
    onSettled: () => {
      queryClient.invalidateQueries(panoramaFilter);
    },
  });
}
