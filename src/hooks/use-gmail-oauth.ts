"use client";

import { useMutation } from "@tanstack/react-query";
import { iniciarConexaoGmail } from "@/lib/api/gmail-oauth";

/**
 * useConectarGmail — inicia o fluxo OAuth do Gmail (POST gmail-oauth
 * { action:'iniciar' }). No sucesso, o componente redireciona o navegador
 * para a URL de consentimento do Google retornada.
 */
export function useConectarGmail() {
  return useMutation({
    mutationFn: () => iniciarConexaoGmail(),
  });
}
