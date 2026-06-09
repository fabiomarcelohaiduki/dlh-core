"use client";

import { useMutation } from "@tanstack/react-query";
import {
  removerDrivePasta,
  salvarDrivePasta,
  type SalvarDrivePastaInput,
} from "@/lib/api/drive-pastas";

/**
 * useSalvarDrivePasta — upsert de pasta do Drive (POST drive-pastas
 * { action:'salvar' }). A lista e hidratada server-side; o componente chama
 * router.refresh() no sucesso para re-hidratar.
 */
export function useSalvarDrivePasta() {
  return useMutation({
    mutationFn: (input: SalvarDrivePastaInput) => salvarDrivePasta(input),
  });
}

/** useRemoverDrivePasta — apaga a pasta por id (POST drive-pastas { action:'remover' }). */
export function useRemoverDrivePasta() {
  return useMutation({
    mutationFn: (id: string) => removerDrivePasta(id),
  });
}
