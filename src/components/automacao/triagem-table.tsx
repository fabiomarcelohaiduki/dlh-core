import type { CSSProperties, ReactNode } from "react";
import { Inbox } from "lucide-react";
import type { TriagemItem } from "@/lib/api/types";
import { formatDataUtc, formatDate, formatHoraUtc } from "@/lib/format";
import { VereditoBadge } from "@/components/automacao/veredito-badge";

export type TriagemVariant = "triagem" | "lixeira" | "fila";

const COLUMNS: Record<TriagemVariant, string[]> = {
  triagem: ["Effecti", "Edital", "Portal", "Órgão / UF", "Abertura", "Hora", "Veredito", "Motivo", "Avaliação"],
  lixeira: ["Effecti", "Edital", "Portal", "Órgão / UF", "Abertura", "Hora", "Veredito", "Motivo", "Descarte previsto"],
  fila: ["Effecti", "Edital", "Portal", "Órgão / UF", "Abertura", "Hora"],
};

/** Truncamento inline (FE-4): motivo na propria linha, sem drawer. */
const truncate: CSSProperties = {
  display: "block",
  maxWidth: 360,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function SkeletonRows({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c}>
              <span
                className="skel skel-line"
                style={{ width: c === cols - 1 ? 120 : `${50 + ((r + c) % 4) * 12}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * cmp-triagem-table — Tabela dos avisos triados (abas Triagem e Lixeira).
 *
 * Estados travados no molde runs-table/erros-table: loading (skeleton), empty
 * (estado vazio) e footer "Carregar mais" (paginacao por cursor). O motivo
 * aparece truncado na propria linha (FE-4, sem drawer). A variante `triagem`
 * tem a coluna de acao (Avaliação) preenchida via `renderAction`; a variante
 * `lixeira` troca a acao pela coluna de data prevista de descarte.
 */
export function TriagemTable({
  items,
  variant = "triagem",
  loading = false,
  emptyTitle,
  emptyDescription,
  renderAction,
  footer,
}: {
  items: TriagemItem[];
  variant?: TriagemVariant;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Coluna de acao da variante `triagem` (feedback inline acertou/errou). */
  renderAction?: (item: TriagemItem) => ReactNode;
  footer?: ReactNode;
}) {
  const columns = COLUMNS[variant];
  const colCount = columns.length;
  const isLixeira = variant === "lixeira";
  const isFila = variant === "fila";

  return (
    <div className="tbl-wrap tbl-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows cols={colCount} />
          ) : items.length === 0 ? (
            <tr>
              <td colSpan={colCount}>
                <div className="empty">
                  <Inbox aria-hidden="true" />
                  <h4>{emptyTitle ?? "Nada por aqui"}</h4>
                  {emptyDescription ? <p>{emptyDescription}</p> : null}
                </div>
              </td>
            </tr>
          ) : (
            items.map((it) => (
              <tr key={it.avisoId}>
                <td className="sub tnum">{it.effectiId || "—"}</td>
                <td className="tnum">{it.edital || "—"}</td>
                <td className="sub">{it.portal || "—"}</td>
                <td>
                  <div className="cell-stack">
                    <span>{it.orgao || "—"}</span>
                    <span className="sub">{it.uf || "—"}</span>
                  </div>
                </td>
                <td className="tnum">{formatDataUtc(it.data)}</td>
                <td className="sub tnum">{formatHoraUtc(it.data)}</td>
                {!isFila && (
                  <>
                    <td>
                      <VereditoBadge veredito={it.veredito} confianca={it.confianca} />
                    </td>
                    <td>
                      <span className="sub" style={truncate} title={it.motivo ?? undefined}>
                        {it.motivo ?? "—"}
                      </span>
                    </td>
                    {isLixeira ? (
                      <td className="sub tnum">{formatDate(it.descartePrevistoEm)}</td>
                    ) : (
                      <td>{renderAction ? renderAction(it) : null}</td>
                    )}
                  </>
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {footer}
    </div>
  );
}
