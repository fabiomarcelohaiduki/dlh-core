"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { fetchAvisoDetalhe, reprocessarAviso } from "@/lib/api/substrato";
import { monitoringKeys } from "@/hooks/use-monitoring";
import { coletaRegistrosKeys } from "@/hooks/use-coleta-registros";

/** Chaves de cache do substrato (detalhe do edital por aviso). */
export const substratoKeys = {
  edital: (avisoId: string): QueryKey => ["edital", avisoId],
};

/**
 * useEdital — detalhe do aviso para a investigacao do erro (US-14).
 * Estados loading/success/error expostos pelo react-query; avisoId
 * inexistente/invalido chega como ApiError 404 ("edital nao encontrado").
 * `enabled` evita disparo quando o deep-link nao traz avisoId.
 */
export function useEdital(avisoId: string | undefined) {
  return useQuery({
    queryKey: substratoKeys.edital(avisoId ?? "—"),
    queryFn: ({ signal }) => fetchAvisoDetalhe(avisoId as string, signal),
    enabled: Boolean(avisoId),
    // Conteudo verbatim/payload bruto sao estaveis; nao revalida em foco.
    refetchOnWindowFocus: false,
  });
}

/**
 * useReprocessar — dispara o reprocesso do item (POST .../reindexar).
 * Em sucesso invalida o detalhe do edital e a lista de erros (o
 * status_reprocesso muda no backend). O bloqueio de duplo disparo na UI
 * deriva de `isPending` somado ao status_reprocesso retornado.
 */
export function useReprocessar(avisoId: string, idComposto?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => reprocessarAviso(avisoId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: substratoKeys.edital(avisoId) });
      queryClient.invalidateQueries({ queryKey: monitoringKeys.errosRoot });
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
      // Guia "Dados": a reindexacao muda o status agregado da linha mestra
      // (e do detalhe expandido, quando conhecido o id_composto).
      queryClient.invalidateQueries({ queryKey: coletaRegistrosKeys.all });
      if (idComposto) {
        queryClient.invalidateQueries({ queryKey: coletaRegistrosKeys.detail(idComposto) });
      }
    },
  });
}
