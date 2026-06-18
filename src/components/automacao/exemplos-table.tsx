import type { CSSProperties, ReactNode } from "react";
import { Inbox, Loader2, Power, Trash2 } from "lucide-react";
import type { ExemploFewShot } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { VereditoBadge } from "@/components/automacao/veredito-badge";

const COLUMNS = ["Texto", "Veredito", "Status", "Criado em", "Ações"];

/** Truncamento inline do texto do exemplo na propria linha (molde FE-4). */
const truncate: CSSProperties = {
  display: "block",
  maxWidth: 420,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {COLUMNS.map((__, c) => (
            <td key={c}>
              <span
                className="skel skel-line"
                style={{ width: c === COLUMNS.length - 1 ? 140 : `${50 + ((r + c) % 4) * 12}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * cmp-exemplos-table — Tabela do acervo few-shot (aba Aprendizado, E14), no
 * molde do triagem-table. Cada linha oferece o toggle `ativo` (soft-delete
 * reversivel via PATCH) e a remocao fisica (DELETE), com loading por linha. As
 * invalidacoes ficam nos hooks consumidos pelo client. Estados loading
 * (skeleton), empty e footer (paginacao) travados.
 */
export function ExemplosTable({
  items,
  loading = false,
  emptyTitle,
  emptyDescription,
  togglingId,
  deletingId,
  onToggle,
  onDelete,
  footer,
}: {
  items: ExemploFewShot[];
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Id do exemplo em PATCH (loading por linha). */
  togglingId?: string | null;
  /** Id do exemplo em DELETE (loading por linha). */
  deletingId?: string | null;
  onToggle?: (exemplo: ExemploFewShot) => void;
  onDelete?: (exemplo: ExemploFewShot) => void;
  footer?: ReactNode;
}) {
  const colCount = COLUMNS.length;

  return (
    <div className="tbl-wrap tbl-scroll">
      <table>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows />
          ) : items.length === 0 ? (
            <tr>
              <td colSpan={colCount}>
                <div className="empty">
                  <Inbox aria-hidden="true" />
                  <h4>{emptyTitle ?? "Nenhum exemplo de aprendizado ainda."}</h4>
                  {emptyDescription ? <p>{emptyDescription}</p> : null}
                </div>
              </td>
            </tr>
          ) : (
            items.map((ex) => {
              const toggling = togglingId === ex.id;
              const deleting = deletingId === ex.id;
              const busy = toggling || deleting;
              return (
                <tr key={ex.id}>
                  <td>
                    <span style={truncate} title={ex.texto}>
                      {ex.texto || "—"}
                    </span>
                  </td>
                  <td>
                    <VereditoBadge veredito={ex.vereditoRotulado} confianca={null} />
                  </td>
                  <td>
                    <span className={cn("tag", ex.ativo ? "util" : undefined)}>
                      {ex.ativo ? "Ativo" : "Inativo"}
                    </span>
                  </td>
                  <td className="sub tnum">{formatDate(ex.criadoEm)}</td>
                  <td>
                    <div className="action-col" role="group" aria-label="Curadoria do exemplo">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        aria-pressed={ex.ativo}
                        onClick={() => onToggle?.(ex)}
                      >
                        {toggling ? (
                          <Loader2 className="spin" aria-hidden="true" />
                        ) : (
                          <Power aria-hidden="true" />
                        )}
                        <span>{ex.ativo ? "Desativar" : "Reativar"}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ color: "var(--err)" }}
                        disabled={busy}
                        onClick={() => onDelete?.(ex)}
                      >
                        {deleting ? (
                          <Loader2 className="spin" aria-hidden="true" />
                        ) : (
                          <Trash2 aria-hidden="true" />
                        )}
                        <span>Remover</span>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      {footer}
    </div>
  );
}
