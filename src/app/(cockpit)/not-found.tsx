import Link from "next/link";

export default function CockpitNotFound() {
  return (
    <section className="screen">
      <div className="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <h4>Tela não encontrada</h4>
        <p>O recurso solicitado não existe no cockpit.</p>
        <div style={{ marginTop: 16 }}>
          <Link href="/dashboard" className="link">
            Voltar ao Dashboard
          </Link>
        </div>
      </div>
    </section>
  );
}
