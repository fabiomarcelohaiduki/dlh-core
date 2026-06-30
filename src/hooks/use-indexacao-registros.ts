"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import {
  fetchIndexacaoRegistroDetalhe,
  fetchIndexacaoRegistros,
  type FetchIndexacaoRegistrosParams,
  type IndexacaoRegistrosResponse,
} from "@/lib/api/indexacao";
import type { FonteIndexacao } from "@/lib/api/types";

/**
 * Polling de fundo da guia "Indexacao". A indexacao (embeddings) e drenada por
 * um daemon continuo (heartbeat cron + push inline), sem estado "em_andamento"
 * por item que justifique intervalo curto — basta revalidar de tempos em tempos
 * para refletir o avanco. Revalida ao focar a aba; nao revalida em background.
 */
export const INDEXACAO_POLL_MS = 8000;

/** Chaves de cache da guia "Indexacao". */
export const indexacaoRegistrosKeys = {
  all: ["indexacao-registros"] as QueryKey,
  list: (params: FetchIndexacaoRegistrosParams): QueryKey => [
    "indexacao-registros",
    "list",
    params,
  ],
  detail: (idComposto: string): QueryKey => ["indexacao-registros", "detail", idComposto],
};

/**
 * useIndexacaoRegistros — uma pagina (keyset) da lista mestra de indexacao +
 * contagens (POST /indexacao { action:'registros' }). Filtros
 * fonte/recurso/status/busca e cursor vivem nos params; trocar qualquer um gera
 * nova chave de cache. Poll de fundo de 8s; revalida ao focar a aba.
 */
export function useIndexacaoRegistros(
  params: FetchIndexacaoRegistrosParams = {},
  options?: { enabled?: boolean },
) {
  return useQuery<IndexacaoRegistrosResponse>({
    queryKey: indexacaoRegistrosKeys.list(params),
    queryFn: () => fetchIndexacaoRegistros(params),
    enabled: options?.enabled ?? true,
    refetchInterval: INDEXACAO_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

/**
 * useIndexacaoRegistroDetalhe — anexos de 1 registro com o status de indexacao
 * individual (POST /indexacao { action:'detalhe' }). LAZY: so dispara quando o
 * registro e expandido na UI (`enabled` externo) e a identidade existe.
 */
export function useIndexacaoRegistroDetalhe(
  idComposto: string | undefined,
  params: { fonte: FonteIndexacao; recurso?: string | null; registroOrigemId: string } | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: indexacaoRegistrosKeys.detail(idComposto ?? "—"),
    queryFn: () => fetchIndexacaoRegistroDetalhe(params!),
    enabled: (options?.enabled ?? true) && Boolean(idComposto) && Boolean(params),
    refetchOnWindowFocus: true,
  });
}
