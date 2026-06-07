export default function CockpitLoading() {
  return (
    <section className="screen" aria-busy="true">
      <div className="page-head">
        <div className="titles">
          <h2 style={{ color: "var(--faint)" }}>Carregando…</h2>
          <p>Preparando os dados do cockpit.</p>
        </div>
      </div>
      <div className="grid-dlh g4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="card"
            style={{ height: 104, opacity: 0.5 }}
            aria-hidden="true"
          />
        ))}
      </div>
    </section>
  );
}
