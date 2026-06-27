"use client";

// =====================================================================
// SessaoProvider — instancia ÚNICA da política de expiração por inatividade.
//
// Monta `useSessao()` uma única vez (dentro da casca autenticada) e expõe o
// resultado ({ warning, doLogout }) via contexto. Assim, tanto o SessionGuard
// (toast de aviso) quanto a view Conta Google (#accountSessionPill) leem o
// MESMO sinal de expiração sem rearmar um segundo timer/listener — preserva o
// comportamento de logout por inatividade (SPEC 3.3.3 / 5.1.3) intacto.
// =====================================================================

import { createContext, useContext, type ReactNode } from "react";
import { useSessao, type UseSessaoResult } from "@/hooks/use-sessao";

const SessaoContext = createContext<UseSessaoResult | null>(null);

/** Default seguro quando consumido fora do provider (defensivo, não desloga). */
const FALLBACK: UseSessaoResult = {
  warning: false,
  doLogout: async () => {},
};

export function SessaoProvider({ children }: { children: ReactNode }) {
  const sessao = useSessao();
  return (
    <SessaoContext.Provider value={sessao}>{children}</SessaoContext.Provider>
  );
}

/** Lê o estado de sessão por inatividade da instância única do provider. */
export function useSessaoContext(): UseSessaoResult {
  return useContext(SessaoContext) ?? FALLBACK;
}
