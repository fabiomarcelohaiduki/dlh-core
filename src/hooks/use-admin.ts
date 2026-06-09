"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  buscaSemantica,
  dispararNomus,
  salvarAgendamentoFonte,
  salvarConfig,
  salvarCredencial,
  testarConexao,
  type BuscaSemanticaInput,
  type SalvarAgendamentoFonteInput,
  type SalvarConfigInput,
} from "@/lib/api/admin";
import { monitoringKeys } from "@/hooks/use-monitoring";
import { fonteKeys } from "@/hooks/use-fontes";
import type { FonteTipo, NomusModo } from "@/lib/api/types";

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
 * useSalvarAgendamentoFonte — persiste o agendamento DESTA fonte (PUT
 * agendamento-fonte-config). Reescreve o pg_cron coleta-<tipo> via
 * aplicar_agendamento_fonte(); vale so para a fonte indicada. Invalida o
 * monitoramento (a proxima coleta agendada passa a refletir no Dashboard).
 */
export function useSalvarAgendamentoFonte() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SalvarAgendamentoFonteInput) => salvarAgendamentoFonte(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
    },
  });
}

/**
 * useDispararNomus — dispara MANUALMENTE a coleta do Nomus (POST nomus-disparar)
 * no modo escolhido (incremental|full). Aciona o workflow do GitHub Actions; a
 * coleta roda assincrona no runner. Invalida o monitoramento (a execucao deve
 * aparecer no Dashboard quando o runner registrar o inicio).
 */
export function useDispararNomus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modo: NomusModo) => dispararNomus(modo),
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
