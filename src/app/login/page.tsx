import type { Metadata } from "next";
import { GoogleButton } from "@/components/auth/google-button";
import { DlhLogo } from "@/components/cockpit/dlh-logo";

export const metadata: Metadata = {
  title: "Entrar no cockpit",
};

type LoginErrorKind = "oauth" | "denied" | null;

function parseError(value?: string): LoginErrorKind {
  if (value === "denied") return "denied";
  if (value === "oauth") return "oauth";
  return null;
}

/**
 * Tela /login (FORA do route group autenticado, publica no middleware).
 * Identidade LionClaw aplicada localmente via .login-screen — a paleta da
 * marca renderiza no /login independentemente do tema da sessao (SPEC 4.3.1).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirectTo?: string; reason?: string }>;
}) {
  const params = await searchParams;
  const initialError = parseError(params.error);
  // EC-03: redirect disparado pela expiracao por inatividade (use-sessao.doLogout).
  const expired = params.reason === "expired";
  const redirectTo =
    params.redirectTo && params.redirectTo.startsWith("/")
      ? params.redirectTo
      : undefined;

  return (
    <main className="login-screen" data-screen="login">
      <div className="login-unit">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <DlhLogo size={76} />
          </span>
          <h1>DLH Core</h1>
        </div>

        <p className="login-sub">
          Nucleo operacional · acesso restrito. Entre com sua conta Google
          corporativa para abrir o cockpit.
        </p>

        {expired && (
          <div className="login-notice" role="status" aria-live="polite">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span>Sua sessao expirou por inatividade.</span>
          </div>
        )}

        <GoogleButton initialError={initialError} redirectTo={redirectTo} />

        <div className="login-foot">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <rect x="4" y="10" width="16" height="11" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
          Sessao autenticada via Supabase Auth · perfil interno unico
        </div>
      </div>
    </main>
  );
}
