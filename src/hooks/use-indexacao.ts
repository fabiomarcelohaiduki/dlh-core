"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  dispararIndexacao,
  fetchIndexacaoResumo,
  salvarConfigIndexacao,
  type SalvarConfigIndexacaoInput,
} from "@/lib/api/indexacao";
import type { FonteIndexacao, IndexacaoResumo } from "@/lib/api/types";

/** Tipo exato que useQuery aceita para refetchInterval (numero ou callback). */
type ResumoRefetchInterval = UseQueryOptions<
  IndexacaoResumo,
  Error,
  IndexacaoResumo,
  QueryKey
>["refetchInterval"];

/** Chaves de cache do painel de indexacao. Resumo e por conjunto de fontes. */
export const indexacaoKeys = {
  resumo: (fontes?: FonteIndexacao[] | null): QueryKey => [
    "indexacao",
    "resumo",
    fontes && fontes.length > 0 ? [...fontes].sort().join(",") : "todas",
  ],
};

/**
 * useIndexacaoResumo — contagens por status_indexacao da(s) fonte(s) (POST
 * indexacao { action:"resumo" }). As contagens vem do Edge (service_role), nao
 * de leitura direta do browser (count direto e fragil por RLS/grant). O
 * refetchInterval condicional da o progresso ao vivo enquanto ha trabalho.
 */
export function useIndexacaoResumo(
  fontes?: FonteIndexacao[] | null,
  options?: { enabled?: boolean; refetchInterval?: ResumoRefetchInterval },
) {
  return useQuery({
    queryKey: indexacaoKeys.resumo(fontes),
    queryFn: () => fetchIndexacaoResumo(fontes),
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

/**
 * useSalvarConfigIndexacao — persiste a config da indexacao (PUT /indexacao).
 * Vale na PROXIMA invocacao do backfill e no proximo push do continuo. Sem
 * invalidacao: a config e hidratada server-side na pagina e o form reflete o
 * salvo localmente.
 */
export function useSalvarConfigIndexacao() {
  return useMutation({
    mutationFn: (input: SalvarConfigIndexacaoInput) => salvarConfigIndexacao(input),
  });
}

/**
 * useDispararIndexacao — aciona 1 lote de backfill da indexacao (POST
 * indexacao { action:"disparar" }). Auto-encadeado pelo banco ate esgotar a
 * fila. So gasta quando o master switch esta ON. Em sucesso invalida o resumo
 * para o progresso comecar a refletir.
 */
export function useDispararIndexacao() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dispararIndexacao(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["indexacao", "resumo"] });
    },
  });
}
