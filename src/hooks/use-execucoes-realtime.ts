"use client";

import { useEffect, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { monitoringKeys } from "@/hooks/use-monitoring";

/** Keys invalidadas por padrao (tela de Execucoes): lista + KPIs. */
const DEFAULT_KEYS: QueryKey[] = [monitoringKeys.execucoesRoot, monitoringKeys.healthcheck];

/**
 * useExecucoesRealtime — progresso ao vivo via Supabase Realtime.
 *
 * Assina mudancas na tabela `execucoes` (respeitando o RLS do usuario
 * autorizado, pois o canal usa o access token da sessao). A cada evento,
 * invalida as `invalidateKeys` informadas para refletir o progresso sem
 * recarregar a pagina.
 *
 * O `execucoes` serve de HEARTBEAT do substrato: toda coleta/extracao roda
 * como execucao, entao o dashboard reusa este canal para refrescar tambem os
 * agregados (healthcheck, extracao, fontes) — basta passar `invalidateKeys` e
 * um `channelName` proprio (cada subscription precisa de nome unico).
 *
 * Retorna `connected`: quando falso, a tela deve cair para o fallback de
 * refetch (TanStack Query) e exibir o indicador "reconectando", preservando
 * o estado processing a partir do banco.
 *
 * IMPORTANTE: `invalidateKeys` e `channelName` devem ter referencia estavel
 * (constante de modulo ou useMemo) — entram no array de dependencias do efeito.
 */
export function useExecucoesRealtime(options?: {
  channelName?: string;
  invalidateKeys?: QueryKey[];
}) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const channelName = options?.channelName ?? "execucoes-realtime";
  const invalidateKeys = options?.invalidateKeys ?? DEFAULT_KEYS;

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const invalidate = () => {
      for (const queryKey of invalidateKeys) {
        queryClient.invalidateQueries({ queryKey });
      }
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
        .channel(channelName)
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
  }, [queryClient, channelName, invalidateKeys]);

  return { connected };
}
