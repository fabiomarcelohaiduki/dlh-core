"use client";

import { useState, useTransition } from "react";
import { useAuth } from "@/hooks/use-auth";

type LoginErrorKind = "oauth" | "denied" | null;

const ERROR_COPY: Record<"oauth" | "denied", string> = {
  oauth: "Não foi possível concluir o login, tente novamente.",
  denied: "Acesso negado: esta conta não está autorizada.",
};

/** cmp-gbtn — Botão "Entrar com Google" (idle / loading / error). */
export function GoogleButton({
  initialError = null,
  redirectTo,
}: {
  initialError?: LoginErrorKind;
  redirectTo?: string;
}) {
  const { signInWithGoogle, signOut } = useAuth();
  const [error, setError] = useState<LoginErrorKind>(initialError);
  const [isPending, startTransition] = useTransition();

  function handleLogin() {
    setError(null);
    startTransition(async () => {
      // Em sucesso, a action redireciona o browser para o Google (navegação).
      // Só retorna valor em falha técnica do OAuth.
      const result = await signInWithGoogle(redirectTo);
      if (result?.error === "oauth") {
        setError("oauth");
      }
    });
  }

  function handleExit() {
    // Ação "Sair" do estado de acesso negado: revoga a sessão (server-side,
    // limpa os cookies httpOnly) e retorna ao /login em estado idle.
    setError(null);
    startTransition(async () => {
      await signOut();
    });
  }

  return (
    <>
      <button
        className="gbtn"
        type="button"
        onClick={handleLogin}
        disabled={isPending}
        aria-busy={isPending}
        data-state={isPending ? "loading" : error ? "error" : "idle"}
      >
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path
            fill="#FFC107"
            d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35 24 35c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 5.1 29.5 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.4-.4-3.5Z"
          />
          <path
            fill="#FF3D00"
            d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 5.1 29.5 3 24 3 16.3 3 9.7 7.3 6.3 14.7Z"
          />
          <path
            fill="#4CAF50"
            d="M24 45c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.9 26.7 37 24 37c-5.3 0-9.7-2.6-11.3-6.9l-6.5 5C9.6 41.6 16.2 45 24 45Z"
          />
          <path
            fill="#1976D2"
            d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.3 5.3C41.4 36 45 30.6 45 24c0-1.2-.1-2.4-.4-3.5Z"
          />
        </svg>
        <span>{isPending ? "Validando sessão…" : "Entrar com Google"}</span>
      </button>

      {error && (
        <div className="login-err" role="alert">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16h.01" />
          </svg>
          <span>{ERROR_COPY[error]}</span>
          {error === "denied" && (
            <button type="button" className="deny-action" onClick={handleExit}>
              Sair
            </button>
          )}
        </div>
      )}
    </>
  );
}
