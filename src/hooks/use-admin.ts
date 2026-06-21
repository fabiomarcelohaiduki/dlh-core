"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  buscaSemantica,
  dispararDrive,
  dispararExtracao,
  dispararGmail,
  dispararNomus,
  dispararOcr,
  salvarAgendamentoExtracao,
  salvarAgendamentoOcr,
  salvarAgendamentoFonte,
  salvarConfig,
  salvarCredencial,
  salvarPainelCredEffecti,
  testarConexao,
  type BuscaSemanticaInput,
  type SalvarAgendamentoExtracaoInput,
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
 * useSalvarPainelCredEffecti — grava/atualiza a credencial do painel web da
 * Effecti (usuario+senha; PUT effecti-painel-cred). Estados
 * idle/loading/success/error expostos pela mutation. O segredo nunca volta na
 * resposta (RNF-02); o sucesso apenas confirma a persistencia.
 */
export function useSalvarPainelCredEffecti() {
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      salvarPainelCredEffecti(username, password),
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
 * useSalvarAgendamentoExtracao — persiste o agendamento da EXTRACAO (PUT
 * extracao-agendamento). Reescreve o pg_cron 'extrair-anexos' via
 * aplicar_agendamento_extracao(); vale na proxima janela. Sem invalidacao: o
 * agendamento nao altera o resumo de extracao na hora.
 */
export function useSalvarAgendamentoExtracao() {
  return useMutation({
    mutationFn: (input: SalvarAgendamentoExtracaoInput) => salvarAgendamentoExtracao(input),
  });
}

/**
 * useSalvarAgendamentoOcr — persiste o agendamento do OCR (PUT ocr-agendamento).
 * Reescreve o pg_cron 'extrair-ocr' via aplicar_agendamento_ocr(); vale na
 * proxima janela. Sem invalidacao: o agendamento nao altera o resumo na hora.
 * Reusa o payload da extracao (forma identica).
 */
export function useSalvarAgendamentoOcr() {
  return useMutation({
    mutationFn: (input: SalvarAgendamentoExtracaoInput) => salvarAgendamentoOcr(input),
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
    mutationFn: ({ modo, recurso }: { modo: NomusModo; recurso?: string }) =>
      dispararNomus(modo, recurso),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
      // Revalida as execucoes para o botao travar assim que o runner registra
      // a coleta em andamento (o anti-duplo-disparo depende dessa lista).
      queryClient.invalidateQueries({ queryKey: monitoringKeys.execucoesRoot });
    },
  });
}

/**
 * useDispararGmail — dispara MANUALMENTE a coleta do Gmail (POST gmail-disparar).
 * Aciona o workflow do GitHub Actions (extrair-anexos.yml com fonte=gmail); a
 * coleta roda assincrona no runner com a janela definida no gmail-config.
 * Invalida o monitoramento (a execucao aparece no Dashboard quando o runner
 * registrar o inicio).
 */
export function useDispararGmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dispararGmail(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
      // Revalida as execucoes para o aviso de coleta em andamento aparecer assim
      // que o runner registrar o inicio.
      queryClient.invalidateQueries({ queryKey: monitoringKeys.execucoesRoot });
    },
  });
}

/**
 * useDispararExtracao — dispara MANUALMENTE a extracao/Drive (POST
 * extracao-disparar). Aciona o workflow extrair-anexos.yml: descobre as pastas
 * Drive ativas e drena a fila de documentos (Tika), assincrono no runner. Sem
 * invalidacao de execucoes (a extracao nao grava linha em execucoes); o resumo
 * de extracao reflete o progresso quando o runner avanca.
 */
export function useDispararExtracao() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dispararExtracao(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
    },
  });
}

/**
 * useDispararOcr — dispara MANUALMENTE o extrator OCR (POST ocr-disparar).
 * Aciona o workflow dedicado extrair-ocr.yml: drena a fila de documentos com
 * status precisa_ocr (escaneados/imagem) com OCR ligado, separado do pipeline
 * rapido, assincrono no runner. Sem invalidacao de execucoes (o OCR nao grava
 * linha em execucoes); o resumo de extracao reflete o progresso.
 */
export function useDispararOcr() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dispararOcr(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
    },
  });
}

/**
 * useDispararDrive — dispara MANUALMENTE a coleta/descoberta do Drive (POST
 * drive-disparar). Aciona o workflow coletar-drive.yml: descobre as pastas Drive
 * ativas e enfileira os vinculos na fila de documentos (sem Tika), assincrono no
 * runner. Sem invalidacao de execucoes (a descoberta do Drive nao grava linha em
 * execucoes); o resumo de extracao reflete os novos vinculos pendentes.
 */
export function useDispararDrive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dispararDrive(),
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
