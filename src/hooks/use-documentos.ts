"use client";

import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  descobrirAnexos,
  fetchExtracaoResumo,
  salvarConfigExtracao,
  type DescobrirInput,
  type SalvarConfigExtracaoInput,
} from "@/lib/api/documentos";

/** Chaves de cache do pipeline de documentos (camada 1). */
export const documentosKeys = {
  resumo: ["documentos", "extracao-resumo"] as QueryKey,
};

/**
 * useExtracaoResumo — contagens por status + anexos que falharam na extracao
 * (POST documentos-descobrir { action:'resumo' }). Alimenta o painel de
 * Extracao em Fontes. As contagens vem do Edge (service_role), nao de leitura
 * direta do browser (regra do projeto: count direto e fragil por RLS/grant).
 */
export function useExtracaoResumo(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: documentosKeys.resumo,
    queryFn: fetchExtracaoResumo,
    enabled: options?.enabled ?? true,
  });
}

/**
 * useDescobrir — enfileira anexos pendentes a partir do Nomus (POST
 * documentos-descobrir). Idempotente. Em sucesso invalida o resumo para
 * refletir os novos pendentes. O extrator do Actions consome a fila depois.
 */
export function useDescobrir() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input?: DescobrirInput) => descobrirAnexos(input ?? {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentosKeys.resumo });
    },
  });
}

/**
 * useSalvarConfigExtracao — persiste os parametros da camada 1 do extrator
 * (PUT /extracao-config). Vale na PROXIMA execucao do runner; nao afeta um
 * job em andamento. Sem invalidacao de cache: a config e hidratada server-side
 * na pagina Fontes e o form reflete o salvo localmente.
 */
export function useSalvarConfigExtracao() {
  return useMutation({
    mutationFn: (input: SalvarConfigExtracaoInput) => salvarConfigExtracao(input),
  });
}
