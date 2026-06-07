"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  buscaSemantica,
  salvarAgendamento,
  salvarConfig,
  salvarCredencial,
  testarConexao,
  type BuscaSemanticaInput,
  type SalvarAgendamentoInput,
  type SalvarConfigInput,
} from "@/lib/api/admin";
import { monitoringKeys } from "@/hooks/use-monitoring";
import { fonteKeys } from "@/hooks/use-fontes";
import type { FonteTipo } from "@/lib/api/types";

/**
 * useSalvarCredencial — grava/atualiza a credencial da fonte (PUT credencial).
 * Parametrizado por fonte (default effecti). Estados idle/loading/success/error
 * expostos pela mutation. O segredo nunca volta na resposta (RNF-02); o sucesso
 * apenas confirma a persistencia.
 */
export function useSalvarCredencial(fonte: FonteTipo = "effecti") {
  return useMutation({
    mutationFn: (token: string) => salvarCredencial(token, fonte),
  });
}

/**
 * useTestarConexao — testa a conexao com a fonte (POST testar). Parametrizado
 * por fonte (default effecti). Independente do salvar: o erro de teste
 * (401/429/timeout) e refletido sem invalidar o sucesso do form. Invalida o
 * healthcheck e a lista de fontes pois o estado_conexao muda.
 */
export function useTestarConexao(fonte: FonteTipo = "effecti") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => testarConexao(fonte),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
      queryClient.invalidateQueries({ queryKey: fonteKeys.all });
    },
  });
}

/**
 * useSalvarConfig — persiste a config de ingestao (PUT config). Vale na
 * proxima execucao, sem redeploy; nao afeta a coleta atual.
 */
export function useSalvarConfig() {
  return useMutation({
    mutationFn: (input: SalvarConfigInput) => salvarConfig(input),
  });
}

/**
 * useSalvarAgendamento — persiste o agendamento GLOBAL do ciclo (PUT
 * agendamento). Reescreve o pg_cron via aplicar_agendamento(); vale para
 * TODAS as fontes (coleta sequencial). Invalida o monitoramento (a proxima
 * coleta agendada passa a refletir no Dashboard/Execucoes).
 */
export function useSalvarAgendamento() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SalvarAgendamentoInput) => salvarAgendamento(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
    },
  });
}

/**
 * useBuscaSemantica — busca semantica do playground (POST busca-semantica).
 * Estados idle/loading/success/empty derivam de isPending + data.results.
 * A falha e tratada como mensagem inline nao-bloqueante (sem estado error).
 */
export function useBuscaSemantica() {
  return useMutation({
    mutationFn: (input: BuscaSemanticaInput) => buscaSemantica(input),
  });
}
