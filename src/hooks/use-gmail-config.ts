"use client";

import { useMutation } from "@tanstack/react-query";
import {
  removerGmailLabel,
  salvarGmailConfig,
  salvarGmailLabel,
  type SalvarGmailLabelInput,
} from "@/lib/api/gmail-config";

/**
 * useSalvarGmailConfig — atualiza a data inicial da coleta (POST gmail-config
 * { action:'salvar-config' }). A config e hidratada server-side; o componente
 * chama router.refresh() no sucesso para re-hidratar.
 */
export function useSalvarGmailConfig() {
  return useMutation({
    mutationFn: (dataInicial: string) => salvarGmailConfig(dataInicial),
  });
}

/** useSalvarGmailLabel — upsert de label da blacklist (POST gmail-config { action:'salvar-label' }). */
export function useSalvarGmailLabel() {
  return useMutation({
    mutationFn: (input: SalvarGmailLabelInput) => salvarGmailLabel(input),
  });
}

/** useRemoverGmailLabel — apaga a label por id (POST gmail-config { action:'remover-label' }). */
export function useRemoverGmailLabel() {
  return useMutation({
    mutationFn: (id: string) => removerGmailLabel(id),
  });
}
