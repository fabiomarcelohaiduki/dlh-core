"use client";

// =====================================================================
// Hooks do dry-run de regra (F3) e da guarda de ativacao (gate S7).
//
//   useDryRunRegra(regra?) - dispara POST /relacionamentos-dry-run para a
//     regra fornecida (ou uma passada no proprio mutate). Retorna a mutation
//     (mutate, data: DryRunResponse, isPending, error, reset). Simulacao pura,
//     NAO persiste, entao NAO invalida caches.
//
//   useAtivarRegra() - dispara POST /relacionamentos-ativar (guarda de
//     ativacao S7). Efeito PERMANENTE: em sucesso invalida a leitura do grafo
//     e o catalogo de regras/vinculos (a teia pode mudar).
// =====================================================================

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ativarRegra, dryRunRegra } from "@/lib/api/relacionamentos-dry-run";
import { relacionamentosLeituraKeys } from "./use-relacionamentos-leitura";
import { relacionamentosRegrasKeys } from "./use-relacionamentos-regras";
import type {
  AtivarRegraInput,
  AtivarRegraResultado,
  DryRunResponse,
  Regra,
} from "@/lib/api/relacionamentos-types";

/** Referencia minima de regra aceita pelo dry-run. */
type RegraRef = Pick<Regra, "id"> | { id: string };

/**
 * useDryRunRegra - dispara o dry-run da regra. Aceita a regra por argumento
 * (bound) e/ou no proprio `mutate(regraOverride)`. Sem invalidacao de cache
 * (o dry-run e read-only).
 */
export function useDryRunRegra(regra?: RegraRef) {
  return useMutation<DryRunResponse, unknown, RegraRef | void>({
    mutationFn: (override) => {
      const alvo = (override ?? regra) as RegraRef | undefined;
      if (!alvo?.id) {
        return Promise.reject(
          new Error("dry-run requer uma regra salva (regra_id)"),
        );
      }
      return dryRunRegra(alvo);
    },
  });
}

/**
 * useAtivarRegra - guarda de ativacao (gate S7). Efeito permanente: invalida
 * a leitura do grafo e o catalogo de regras/vinculos ao concluir.
 */
export function useAtivarRegra() {
  const queryClient = useQueryClient();
  return useMutation<AtivarRegraResultado, unknown, AtivarRegraInput>({
    mutationFn: (input) => ativarRegra(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: relacionamentosLeituraKeys.all });
      queryClient.invalidateQueries({ queryKey: relacionamentosRegrasKeys.all });
      queryClient.invalidateQueries({ queryKey: ["relacionamentos-vinculos-lia"] });
    },
  });
}
