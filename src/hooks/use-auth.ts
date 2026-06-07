"use client";

import { useCallback, useContext } from "react";
import { SessionContext } from "@/components/auth/session-provider";
import { loginWithGoogle, logout, type LoginError } from "@/app/actions/auth";

export type AuthStatus = "authenticated" | "unauthenticated";

/**
 * useSession: identidade do usuário conhecida pelo servidor (cookies httpOnly,
 * nunca lidos por scripts). Seedada via SessionProvider no layout do cockpit.
 */
export function useSession() {
  const user = useContext(SessionContext);
  const status: AuthStatus = user ? "authenticated" : "unauthenticated";
  return { user, status };
}

/**
 * useAuth: ações de autenticação.
 *  - signInWithGoogle -> action-login-google (POST /auth/google, modo iniciação)
 *  - signOut          -> revoga a sessão e limpa os cookies httpOnly (server-side)
 */
export function useAuth() {
  const session = useSession();

  const signInWithGoogle = useCallback(
    async (redirectTo?: string): Promise<LoginError | void> => {
      // Em sucesso a action redireciona o browser ao Google (navegação);
      // só retorna valor em falha técnica do OAuth.
      return await loginWithGoogle(redirectTo);
    },
    [],
  );

  const signOut = useCallback(async () => {
    await logout();
  }, []);

  return { ...session, signInWithGoogle, signOut };
}
