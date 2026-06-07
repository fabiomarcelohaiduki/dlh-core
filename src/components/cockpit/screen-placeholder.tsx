import type { ReactNode } from "react";

/**
 * Placeholder on-brand para as telas do cockpit ainda não implementadas
 * (serão preenchidas nas próximas sprints). Mantém o Design Lock visível
 * sem introduzir nada fora do contrato.
 */
export function ScreenPlaceholder({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>

      <div className="banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
        <div>
          <b>Tela em construção</b>
          <p>
            Esta área será implementada nas próximas sprints do cockpit. O shell,
            a navegação e a sessão já estão ativos.
          </p>
        </div>
      </div>

      {children}
    </section>
  );
}
