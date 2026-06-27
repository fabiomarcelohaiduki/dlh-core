import Link from "next/link";

export default function NotFound() {
  return (
    <main className="login-screen">
      <div className="login-unit" style={{ textAlign: "center" }}>
        <div className="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <h4>Página não encontrada</h4>
          <p>O endereço acessado não existe.</p>
          <div style={{ marginTop: 16 }}>
            <Link href="/dashboard" className="link">
              Ir para o cockpit
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
