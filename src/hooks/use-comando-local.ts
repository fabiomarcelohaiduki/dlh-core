"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  enfileirarComandoLocal,
  listarComandosLocal,
  type ComandoLocal,
  type ComandoLocalTipo,
} from "@/lib/api/comando-local";

export const comandoLocalKeys = {
  all: ["comando-local"] as const,
  lista: ["comando-local", "lista"] as const,
};

/** Ha comando ativo (pendente ou executando) -> poll rapido para o status andar. */
function temComandoAtivo(comandos: ComandoLocal[] | undefined): boolean {
  return (comandos ?? []).some((c) => c.status === "pendente" || c.status === "executando");
}

/**
 * useComandosLocal — lista os comandos da fila e faz POLL do status. Cadencia
 * adaptativa: 5s enquanto ha comando ativo (pendente/executando) para o
 * cockpit refletir o PC quase em tempo real; 30s quando tudo ja foi selado.
 */
export function useComandosLocal() {
  return useQuery({
    queryKey: comandoLocalKeys.lista,
    queryFn: listarComandosLocal,
    refetchInterval: (query) => (temComandoAtivo(query.state.data) ? 5_000 : 30_000),
  });
}

/**
 * useEnfileirarComandoLocal — enfileira um comando para o PC (POST). Invalida a
 * lista no sucesso para o novo 'pendente' aparecer na hora; o poll cuida do
 * resto da progressao. 409 (comando ja na fila) chega como erro da mutation.
 */
export function useEnfileirarComandoLocal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (comando: ComandoLocalTipo) => enfileirarComandoLocal(comando),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: comandoLocalKeys.lista });
    },
  });
}
