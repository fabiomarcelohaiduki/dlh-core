"use client";

import { useState, useTransition } from "react";
import { useAuth } from "@/hooks/use-auth";

type LoginErrorKind = "oauth" | "denied" | null;

const ERROR_COPY: Record<"oauth" | "denied", string> = {
  oauth: "Nao foi possivel concluir o login, tente novamente.",
  denied: "Acesso negado: esta conta nao esta autorizada.",
};

/**
 * cmp-gbtn — Botao "Entrar com Google" (idle / submitting / error).
 * Dispara o fluxo OAuth (signInWithOAuth provider google) via server action;
 * em sucesso o browser navega para o Google. Estados conforme SPEC 4.5.
 */
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
      // Em sucesso, a action redireciona o browser para o Google (navegacao).
      // So retorna valor em falha tecnica do OAuth.
      const result = await signInWithGoogle(redirectTo);
      if (result?.error === "oauth") {
        setError("oauth");
      }
    });
  }

  function handleExit() {
    // Acao "Sair" do estado de acesso negado: revoga a sessao (server-side,
    // limpa os cookies httpOnly) e retorna ao /login em estado idle.
    setError(null);
    startTransition(async () => {
      await signOut();
    });
  }

  return (
    <div className="login-action">
      <button
        id="submitGoogleLogin"
        className="google-login"
        type="button"
        onClick={handleLogin}
        disabled={isPending}
        aria-busy={isPending}
        data-state={isPending ? "submitting" : error ? "error" : "idle"}
      >
        <svg className="google-g" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M22.6 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h6c-.3 1.4-1 2.5-2.1 3.2v2.7h3.4c2-1.8 3.3-4.5 3.3-7.9z"
          />
          <path
            fill="#34A853"
            d="M12 23c3 0 5.5-1 7.3-2.8l-3.4-2.7c-.9.6-2.2 1-3.9 1-3 0-5.5-2-6.4-4.7H2.1v2.8C3.9 20.4 7.7 23 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.6 13.8c-.2-.6-.4-1.2-.4-1.8s.1-1.2.4-1.8V7.4H2.1C1.4 8.8 1 10.3 1 12s.4 3.2 1.1 4.6l3.5-2.8z"
          />
          <path
            fill="#EA4335"
            d="M12 5.5c1.6 0 3 .6 4.1 1.6l3.1-3.1C17.5 2.2 15 1 12 1 7.7 1 3.9 3.6 2.1 7.4l3.5 2.8C6.5 7.5 9 5.5 12 5.5z"
          />
        </svg>
        <span>{isPending ? "Conectando…" : "Entrar com Google"}</span>
      </button>

      {error && (
        <div className="login-error" role="alert">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
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
    </div>
  );
}
