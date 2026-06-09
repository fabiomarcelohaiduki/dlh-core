"use client";

import { useMutation } from "@tanstack/react-query";
import { iniciarConexaoDrive } from "@/lib/api/drive-oauth";

/**
 * useConectarDrive — inicia o fluxo OAuth do Drive (POST drive-oauth
 * { action:'iniciar' }). No sucesso, o componente redireciona o navegador
 * para a URL de consentimento do Google retornada.
 */
export function useConectarDrive() {
  return useMutation({
    mutationFn: () => iniciarConexaoDrive(),
  });
}
