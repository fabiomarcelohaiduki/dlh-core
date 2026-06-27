"use client";

import { Component, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

/**
 * widget-error — fallback de erro isolado por widget do cockpit (SPEC 4.5).
 *
 * Degradacao por widget: um painel que falha ao renderizar resolve a propria
 * falha sem derrubar a view inteira. Visualmente alinhado aos demais paineis
 * (`.card`), mas com tom de erro.
 */
export function WidgetError({
  title = "Widget indisponível",
  message = "Não foi possível renderizar este painel.",
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="card cockpit-widget cockpit-widget-error" role="alert">
      <TriangleAlert aria-hidden="true" />
      <div className="cockpit-widget-error-copy">
        <b>{title}</b>
        <p>{message}</p>
      </div>
      {onRetry != null ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Tentar novamente
        </button>
      ) : null}
    </div>
  );
}

/**
 * Error boundary que envolve os paineis fixos do cockpit e troca a arvore que
 * falhou pelo WidgetError. Mantem os demais paineis vivos.
 */
export class WidgetErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? <WidgetError />;
    }
    return this.props.children;
  }
}
