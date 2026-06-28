"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  listarColetaLog,
  mapColetaLogLinha,
  type ColetaLogLinha,
  type ColetaLogOrigem,
} from "@/lib/api/coleta-log";

// Teto de linhas em memoria: o console e a "janela do agora", nao historico.
// Linhas antigas saem pelo topo conforme novas chegam (mesma ideia da retencao
// de 48h no banco, mas aqui no cliente para nao crescer sem limite).
const TETO_LINHAS = 1000;
// Carga inicial: traz as ultimas N para o console nao abrir vazio.
const LIMITE_CARGA = 400;
// Polling de fallback: re-busca as ultimas linhas a cada N ms e anexa o que
// for novo (dedup por id). Garante atualizacao mesmo quando o Realtime nao
// entrega (canal caido / "Reconectando…"), sem depender de remontar a tela.
const INTERVALO_POLL_MS = 5000;

interface UseColetaLogResult {
  /** Linhas em ordem cronologica (mais antiga no topo, mais nova embaixo). */
  linhas: ColetaLogLinha[];
  /** Realtime conectado; quando falso, so a carga inicial esta na tela. */
  connected: boolean;
  /** Carga inicial em andamento. */
  carregando: boolean;
  /** Limpa o console (so a visao local; nao apaga o banco). */
  limpar: () => void;
}

/**
 * useColetaLog — alimenta o console ao vivo da guia "Logs" da Coleta.
 *
 * 1) Carga inicial pela Edge coleta-log (ultimas N linhas, ja cronologicas).
 * 2) Stream pelo Supabase Realtime (INSERT em coleta_log), respeitando o RLS
 *    do usuario autorizado (canal usa o access token da sessao). Cada INSERT
 *    e anexado ao fim e o buffer e podado em TETO_LINHAS.
 *
 * O filtro por `origem` e aplicado tanto na carga quanto no stream; trocar de
 * fonte refaz a carga e reassina o canal.
 */
export function useColetaLog(origem?: ColetaLogOrigem): UseColetaLogResult {
  const [linhas, setLinhas] = useState<ColetaLogLinha[]>([]);
  const [connected, setConnected] = useState(false);
  const [carregando, setCarregando] = useState(true);

  // Dedup por id: o Realtime pode entregar uma linha que a carga ja trouxe
  // (corrida entre o GET e a subscription). Ref para nao re-renderizar.
  const vistosRef = useRef<Set<number>>(new Set());

  const anexar = useCallback((novas: ColetaLogLinha[]) => {
    if (novas.length === 0) return;
    setLinhas((atual) => {
      const vistos = vistosRef.current;
      const ineditas = novas.filter((l) => !vistos.has(l.id));
      if (ineditas.length === 0) return atual;
      for (const l of ineditas) vistos.add(l.id);
      const combinado = atual.concat(ineditas);
      // Ordena por id (ordem cronologica estavel, monotonica no banco) e poda.
      combinado.sort((a, b) => a.id - b.id);
      if (combinado.length > TETO_LINHAS) {
        const podadas = combinado.slice(combinado.length - TETO_LINHAS);
        vistos.clear();
        for (const l of podadas) vistos.add(l.id);
        return podadas;
      }
      return combinado;
    });
  }, []);

  const limpar = useCallback(() => {
    vistosRef.current.clear();
    setLinhas([]);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    // Reset ao trocar de fonte: o console recomeca para a fonte selecionada.
    vistosRef.current.clear();
    setLinhas([]);
    setCarregando(true);

    void (async () => {
      // Carga inicial.
      try {
        const iniciais = await listarColetaLog({ limite: LIMITE_CARGA, origem });
        if (!active) return;
        for (const l of iniciais) vistosRef.current.add(l.id);
        setLinhas(iniciais);
      } catch {
        // Falha de carga nao impede o stream; console comeca vazio.
      } finally {
        if (active) setCarregando(false);
      }
      if (!active) return;

      // Stream ao vivo (RLS via JWT do usuario).
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.access_token) supabase.realtime.setAuth(session.access_token);
      if (!active) return;

      const filtro = origem ? `origem=eq.${origem}` : undefined;
      channel = supabase
        .channel(`coleta-log-${origem ?? "todas"}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "coleta_log", filter: filtro },
          (payload) => {
            const raw = payload.new as Parameters<typeof mapColetaLogLinha>[0];
            anexar([mapColetaLogLinha(raw)]);
          },
        )
        .subscribe((status) => {
          if (!active) return;
          setConnected(String(status) === "SUBSCRIBED");
        });

      // Polling de fallback: re-busca as ultimas linhas e anexa o que for novo.
      // O dedup por id em `anexar` torna isto inofensivo quando o Realtime ja
      // entregou as mesmas linhas; quando o canal cai, e o que mantem a tela viva.
      timer = setInterval(() => {
        void (async () => {
          try {
            const recentes = await listarColetaLog({ limite: LIMITE_CARGA, origem });
            if (active) anexar(recentes);
          } catch {
            // Falha de poll e silenciosa; a proxima tentativa cobre.
          }
        })();
      }, INTERVALO_POLL_MS);
    })();

    return () => {
      active = false;
      setConnected(false);
      if (timer) clearInterval(timer);
      if (channel) supabase.removeChannel(channel);
    };
  }, [origem, anexar]);

  return useMemo(
    () => ({ linhas, connected, carregando, limpar }),
    [linhas, connected, carregando, limpar],
  );
}
