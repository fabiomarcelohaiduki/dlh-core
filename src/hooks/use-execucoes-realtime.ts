"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { monitoringKeys } from "@/hooks/use-monitoring";

/**
 * useExecucoesRealtime — progresso ao vivo das execucoes via Supabase Realtime.
 *
 * Assina mudancas na tabela `execucoes` (respeitando o RLS do usuario
 * autorizado, pois o canal usa o access token da sessao). A cada evento,
 * invalida as queries de execucoes/healthcheck para refletir o progresso
 * (etapa_atual, novos, alterados, status) sem recarregar a pagina.
 *
 * Retorna `connected`: quando falso, a tela deve cair para o fallback de
 * refetch (TanStack Query) e exibir o indicador "reconectando", preservando
 * o estado processing a partir do banco.
 */
export function useExecucoesRealtime() {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: monitoringKeys.execucoesRoot });
      queryClient.invalidateQueries({ queryKey: monitoringKeys.healthcheck });
    };

    void (async () => {
      // Garante que o canal Realtime use o JWT do usuario (RLS).
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }
      if (!active) return;

      channel = supabase
        .channel("execucoes-realtime")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "execucoes" },
          () => invalidate(),
        )
        .subscribe((status) => {
          if (!active) return;
          // status e um enum string do supabase-js; compara via String().
          setConnected(String(status) === "SUBSCRIBED");
        });
    })();

    return () => {
      active = false;
      setConnected(false);
      if (channel) supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return { connected };
}
