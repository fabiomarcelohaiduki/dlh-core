"use client";

// =====================================================================
// use-tema — wrapper next-themes que espelha `configuracao.tema_id` (SPEC 4.8.8).
//
// O catalogo de temas e UUID-based (`configuracao.tema_id`), enquanto o
// next-themes opera por nome (`lionclaw`/`claro`/`grafite`/`salvia`). Este hook:
//   1. le o catalogo de temas (cache estatico);
//   2. espelha o `tema_id` salvo aplicando o tema via next-themes;
//   3. ao selecionar um tema, aplica no next-themes E persiste o tema_id (live).
// =====================================================================

import { useEffect, useMemo } from "react";
import { useTheme } from "next-themes";
import { useQuery } from "@tanstack/react-query";
import { getTemas, nomeDeTemaId, temaIdDeNome } from "@/lib/api/tema";
import {
  useConfiguracao,
  usePatchConfiguracao,
} from "@/hooks/use-configuracao";
import type { LionclawTheme } from "@/components/theme-provider";

/** Chave de cache do catalogo de temas. */
export const temaKeys = {
  all: ["tema"] as const,
};

/** Leitura do catalogo de temas (estatico: 4 temas seed). */
export function useTemas(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: temaKeys.all,
    queryFn: getTemas,
    staleTime: Infinity,
    enabled: options?.enabled ?? true,
  });
}

/**
 * Hook de tema do cockpit. Espelha `configuracao.tema_id` no next-themes e
 * expoe `selecionarTema` para alternar (aplica + persiste ao vivo).
 */
export function useTema() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { data: configuracao } = useConfiguracao();
  const patch = usePatchConfiguracao();

  const nome = useMemo<LionclawTheme>(
    () => nomeDeTemaId(configuracao?.temaId ?? null),
    [configuracao?.temaId],
  );

  // Espelha o tema salvo no next-themes quando a configuracao carrega/muda.
  useEffect(() => {
    if (configuracao && theme !== nome) {
      setTheme(nome);
    }
  }, [configuracao, nome, theme, setTheme]);

  /**
   * Aplica o tema no next-themes e persiste o tema_id na configuracao (live).
   *
   * EC-19: a aplicacao visual e otimista (setTheme imediato). Se o PATCH falhar,
   * revertemos o next-themes para o tema anterior (sem flash incorreto) e
   * notificamos via `onError` para o chamador exibir o toast de erro.
   */
  function selecionarTema(
    nomeTema: LionclawTheme,
    opts?: { onError?: () => void },
  ): void {
    const anterior = nome;
    setTheme(nomeTema);
    patch.mutate(
      { temaId: temaIdDeNome(nomeTema) },
      {
        onError: () => {
          setTheme(anterior);
          opts?.onError?.();
        },
      },
    );
  }

  return {
    temaId: configuracao?.temaId ?? null,
    nome,
    theme,
    resolvedTheme,
    selecionarTema,
    salvando: patch.isPending,
  };
}
