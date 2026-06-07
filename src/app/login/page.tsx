import type { Metadata } from "next";
import { GoogleButton } from "@/components/auth/google-button";

export const metadata: Metadata = {
  title: "Entrar no cockpit",
};

type LoginErrorKind = "oauth" | "denied" | null;

function parseError(value?: string): LoginErrorKind {
  if (value === "denied") return "denied";
  if (value === "oauth") return "oauth";
  return null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirectTo?: string }>;
}) {
  const params = await searchParams;
  const initialError = parseError(params.error);
  const redirectTo =
    params.redirectTo && params.redirectTo.startsWith("/")
      ? params.redirectTo
      : undefined;

  return (
    <main className="login-root">
      <div className="login-card">
        <div className="brandmark">
          <span className="glyph">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z" />
              <path d="M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7" />
              <path d="M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5" />
            </svg>
          </span>
          <span className="name">
            DLH Core <span>· Substrato + cockpit de ingestão</span>
          </span>
        </div>

        <div className="login-panel">
          <h1>Entrar no cockpit</h1>
          <p className="sub">
            Acesso restrito ao núcleo operacional DLH. Use sua conta Google corporativa.
          </p>

          <GoogleButton initialError={initialError} redirectTo={redirectTo} />

          <div className="login-foot">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="4" y="10" width="16" height="11" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            Sessão autenticada via Supabase Auth · perfil interno único
          </div>
        </div>
      </div>
    </main>
  );
}
