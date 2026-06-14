"use client";

import { useQueries, type QueryKey } from "@tanstack/react-query";
import { getDocumentosDados } from "@/lib/api/produtos";

/** Chaves de cache dos dados de documentos (Catalogo / Ficha) por Linha. */
export const documentosDadosKeys = {
  all: ["documentos-dados"] as QueryKey,
  byLinha: (linhaId: string): QueryKey => ["documentos-dados", linhaId],
};

/**
 * useDocumentosDados — busca os dados de documentos de VARIAS Linhas em
 * paralelo (Catalogo/Ficha de uma/varias/todas as linhas). Mantem a ordem dos
 * linhaIds recebidos para reproduzir a selecao do usuario na impressao.
 */
export function useDocumentosDados(linhaIds: string[]) {
  return useQueries({
    queries: linhaIds.map((linhaId) => ({
      queryKey: documentosDadosKeys.byLinha(linhaId),
      queryFn: () => getDocumentosDados(linhaId),
    })),
  });
}
