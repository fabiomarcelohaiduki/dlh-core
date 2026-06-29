"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import {
  fetchExtracaoFila,
  type ExtracaoFilaParams,
  type ExtracaoFilaResponse,
} from "@/lib/api/documentos";

/**
 * Polling de fundo da guia "Fila de extracao". A fila e drenada por um runner
 * externo (Tika/OCR), nao ha estado "em_andamento" por item para encurtar o
 * intervalo — basta revalidar de tempos em tempos para refletir o avanco da
 * fila. Revalida ao focar a aba; nao revalida em background.
 */
export const FILA_POLL_MS = 8000;

/** Chaves de cache da guia "Fila de extracao". */
export const extracaoFilaKeys = {
  all: ["extracao-fila"] as QueryKey,
  list: (params: ExtracaoFilaParams): QueryKey => ["extracao-fila", "list", params],
};

/**
 * useExtracaoFila — uma pagina (keyset) da fila de extracao + contagens
 * (POST /documentos-descobrir { action:'fila-paginada' }). Filtros
 * fonte/status/busca e cursor vivem nos params; trocar qualquer um gera nova
 * chave de cache. Poll de fundo de 8s; revalida ao focar a aba.
 */
export function useExtracaoFila(
  params: ExtracaoFilaParams = {},
  options?: { enabled?: boolean },
) {
  return useQuery<ExtracaoFilaResponse>({
    queryKey: extracaoFilaKeys.list(params),
    queryFn: () => fetchExtracaoFila(params),
    enabled: options?.enabled ?? true,
    refetchInterval: FILA_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
