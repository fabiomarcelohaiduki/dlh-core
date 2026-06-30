"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  dispararIndexacao,
  reprocessarErrosIndexacao,
  salvarConfigIndexacao,
  type SalvarConfigIndexacaoInput,
} from "@/lib/api/indexacao";
import { indexacaoRegistrosKeys } from "@/hooks/use-indexacao-registros";
import type { FonteIndexacao } from "@/lib/api/types";

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
 * fila. So gasta quando o master switch esta ON. Em sucesso invalida a lista
 * mestra da guia Indexacao para o progresso comecar a refletir.
 */
export function useDispararIndexacao() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dispararIndexacao(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: indexacaoRegistrosKeys.all });
    },
  });
}

/**
 * useReprocessarErrosIndexacao — move os documentos em erro de volta para
 * pendente da(s) fonte(s) e reabre o backfill (POST indexacao
 * { action:"reprocessar_erros" }). Em sucesso invalida a lista mestra da guia
 * Indexacao para refletir a fila reaberta.
 */
export function useReprocessarErrosIndexacao(fontes?: FonteIndexacao[] | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => reprocessarErrosIndexacao(fontes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: indexacaoRegistrosKeys.all });
    },
  });
}
