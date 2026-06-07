import { TriangleAlert } from "lucide-react";

/**
 * Estado de erro isolado por widget (degradacao por widget): cada bloco do
 * Dashboard/Execucoes resolve sua propria falha sem derrubar a tela toda.
 */
export function WidgetError({
  title = "Não foi possível carregar",
  message = "Ocorreu uma falha ao buscar os dados. Tente novamente.",
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="tbl-wrap">
      <div className="empty">
        <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
        <h4>{title}</h4>
        <p>{message}</p>
        {onRetry ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRetry}
            style={{ marginTop: 16 }}
          >
            Tentar novamente
          </button>
        ) : null}
      </div>
    </div>
  );
}
