import type { CSSProperties, ReactNode } from "react";
import { Inbox } from "lucide-react";
import type { FalsoDescarteAmostra, Veredito } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const COLUMNS = ["Objeto", "Veredito", "Confiança", "Processo Nomus"];

const VEREDITO_LABEL: Record<Veredito, string> = {
  util: "Útil",
  duvida: "Dúvida",
  lixo: "Lixo",
};

/** Truncamento inline do objeto na propria linha (FE-4, molde triagem-table). */
const truncate: CSSProperties = {
  display: "block",
  maxWidth: 360,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Confianca crua -> percentual inteiro; nula -> "—" (E11). */
function formatConfianca(confianca: number | null): string {
  return confianca != null ? `${Math.round(confianca * 100)}%` : "—";
}

function SkeletonRows({ rows = 5 }: { rows?: number }) {
  const cols = COLUMNS.length;
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
 * cmp-falso-descarte-table — Amostras de falso-descarte (recall miss) do
 * backtest. Lista os avisos que viraram processo real no Nomus mas que a
 * triagem mandaria para a lixeira: objeto, veredito, confianca crua e a
 * referencia do processo Nomus que confirma o erro. Molde da triagem-table
 * (mesmos estados loading/empty e truncamento inline), somente leitura.
 */
export function FalsoDescarteTable({
  items,
  loading = false,
  emptyTitle = "Nenhum falso-descarte no período.",
  emptyDescription = "A triagem preservou todos os avisos que viraram processo real no Nomus.",
  footer,
}: {
  items: FalsoDescarteAmostra[];
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
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
                  <h4>{emptyTitle}</h4>
                  {emptyDescription ? <p>{emptyDescription}</p> : null}
                </div>
              </td>
            </tr>
          ) : (
            items.map((it) => (
              <tr key={it.avisoId}>
                <td>
                  <span style={truncate} title={it.objeto}>
                    {it.objeto || "—"}
                  </span>
                </td>
                <td>
                  <span className={cn("tag", it.veredito)}>
                    {VEREDITO_LABEL[it.veredito]}
                  </span>
                </td>
                <td className="sub tnum">{formatConfianca(it.confianca)}</td>
                <td className="sub tnum">{it.nomusProcessoRef || "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {footer}
    </div>
  );
}
