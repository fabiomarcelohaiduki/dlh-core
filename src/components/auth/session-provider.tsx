"use client";

import { createContext, type ReactNode } from "react";

export type SessionUser = { email: string } | null;

/**
 * Contexto de sessão alimentado pelo servidor. A sessão real vive em cookies
 * httpOnly (não acessíveis a scripts); o cliente recebe apenas a identidade
 * mínima necessária para a UI, evitando ler o cookie de auth no browser.
 */
export const SessionContext = createContext<SessionUser>(null);

export function SessionProvider({
  user,
  children,
}: {
  user: SessionUser;
  children: ReactNode;
}) {
  return (
    <SessionContext.Provider value={user}>{children}</SessionContext.Provider>
  );
}
