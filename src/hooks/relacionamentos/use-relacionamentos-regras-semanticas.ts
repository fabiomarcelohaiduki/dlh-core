"use client";

// =====================================================================
// Hooks da feature "Relacionamentos" - regras semanticas (F4).
//
//   useRelacionamentosRegrasSemanticas - GET keyset (candidatos) + ajustes
//                                        render-only. Expoe "Carregar mais".
//   useAcaoRegraSemantica              - POST acao (ativar/desativar candidato)
//
// A leitura usa useInfiniteQuery por baixo (paginacao KEYSET via cursor opaco),
// mas expoe uma forma amigavel:
//   { data: { candidatos, ajustes_tecnicos_lia }, hasNextPage, fetchNextPage, ... }
// onde `candidatos` e o achatado de TODAS as paginas carregadas e
// `ajustes_tecnicos_lia` vem da primeira pagina (o bloco e estavel entre elas).
// =====================================================================

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  acaoRelacionamentosRegraSemantica,
  getRelacionamentosRegrasSemanticas,
} from "@/lib/api/relacionamentos-regras-semanticas";
import type {
  AjustesTecnicosLia,
  RegraSemanticaAcaoInput,
  RegraSemanticaCandidato,
} from "@/lib/api/relacionamentos-types";
import { relacionamentosLeituraKeys } from "./use-relacionamentos-leitura";

/** Prefixo comum de todas as paginas de regras semanticas (qualquer limite). */
const REGRAS_SEMANTICAS_PREFIX = ["relacionamentos-leitura", "regras-semanticas"] as const;

/** Forma agregada devolvida pela leitura de regras semanticas. */
export interface RegrasSemanticasAgregado {
  candidatos: RegraSemanticaCandidato[];
  ajustes_tecnicos_lia: AjustesTecnicosLia | null;
}

/**
 * useRelacionamentosRegrasSemanticas - leitura keyset dos 2 blocos.
 * @param limite tamanho de pagina (default do backend = 25, max = 100).
 */
export function useRelacionamentosRegrasSemanticas(limite?: number) {
  const query = useInfiniteQuery({
    queryKey: relacionamentosLeituraKeys.regrasSemanticas(limite),
    queryFn: ({ pageParam }) =>
      getRelacionamentosRegrasSemanticas({ cursor: pageParam, limite }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const pages = query.data?.pages ?? [];
  const candidatos = pages.flatMap((p) => p.candidatos);
  const ajustes_tecnicos_lia = pages[0]?.ajustes_tecnicos_lia ?? null;

  const data: RegrasSemanticasAgregado = { candidatos, ajustes_tecnicos_lia };

  return {
    data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    isFetching: query.isFetching,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

/**
 * useAcaoRegraSemantica - POST acao (ativar/desativar candidato). Invalida
 * TODAS as paginacoes de regras semanticas para reler do zero (o keyset muda
 * quando um candidato sai/entra do recorte). ajustes_tecnicos -> 403 (o
 * backend rejeita; a UI nunca deve chamar com esse bloco).
 */
export function useAcaoRegraSemantica() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegraSemanticaAcaoInput) => acaoRelacionamentosRegraSemantica(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REGRAS_SEMANTICAS_PREFIX });
    },
  });
}
