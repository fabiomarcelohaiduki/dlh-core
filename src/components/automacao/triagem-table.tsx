"use client";

import { type CSSProperties, Fragment, type ReactNode, useState } from "react";
import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import type { TriagemItem } from "@/lib/api/types";
import { formatDataBr, formatDate, formatHoraBr } from "@/lib/format";
import { VereditoBadge } from "@/components/automacao/veredito-badge";
import { AvisoItensPanel } from "@/components/automacao/aviso-itens-panel";

export type TriagemVariant = "triagem" | "lixeira" | "fila";

const COLUMNS: Record<TriagemVariant, string[]> = {
  triagem: ["Effecti", "Portal", "Órgão / UF", "UASG", "Edital", "Abertura", "Hora", "Veredito", "Motivo", "Avaliação"],
  lixeira: ["Effecti", "Portal", "Órgão / UF", "UASG", "Edital", "Abertura", "Hora", "Veredito", "Motivo", "Descarte previsto"],
  fila: ["Effecti", "Portal", "Órgão / UF", "UASG", "Edital", "Abertura", "Hora"],
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
  // +1 = coluna do expansor (itens extraidos pela Lia, recall por item).
  const colCount = columns.length + 1;
  const isLixeira = variant === "lixeira";
  const isFila = variant === "fila";
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="tbl-wrap tbl-scroll">
      <table>
        <thead>
          <tr>
            <th aria-hidden="true" style={{ width: 32 }} />
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
            items.map((it) => {
              const expanded = expandedId === it.avisoId;
              return (
              <Fragment key={it.avisoId}>
              <tr>
                <td>
                  <button
                    type="button"
                    className="btn-icon"
                    aria-expanded={expanded}
                    aria-label={expanded ? "Recolher itens do edital" : "Ver itens do edital"}
                    onClick={() => setExpandedId(expanded ? null : it.avisoId)}
                  >
                    {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                  </button>
                </td>
                <td className="sub tnum">{it.effectiId || "—"}</td>
                <td className="sub tnum">{it.portal || "—"}</td>
                <td className="sub tnum">
                  <div className="cell-stack">
                    <span>{it.orgao || "—"}</span>
                    <span className="sub">{it.uf || "—"}</span>
                  </div>
                </td>
                <td className="sub tnum">{it.uasg || "—"}</td>
                <td className="sub tnum">{it.edital || "—"}</td>
                <td className="sub tnum">{formatDataBr(it.data)}</td>
                <td className="sub tnum">{formatHoraBr(it.data)}</td>
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
              {expanded && (
                <tr>
                  <td aria-hidden="true" />
                  <td colSpan={colCount - 1}>
                    <AvisoItensPanel avisoId={it.avisoId} />
                  </td>
                </tr>
              )}
              </Fragment>
              );
            })
          )}
        </tbody>
      </table>
      {footer}
    </div>
  );
}
