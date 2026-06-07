import type { ReactNode } from "react";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import type { Erro } from "@/lib/api/types";
import { severidadeDescriptor } from "@/lib/status";
import { formatDateTime, formatRecurso } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/cockpit/status-pill";
import { OrigemBadge } from "@/components/cockpit/origem-badge";

type Variant = "dashboard" | "erros";

const COLUMNS: Record<Variant, string[]> = {
  dashboard: ["Etapa", "Aviso / item", "Mensagem", "Quando", ""],
  erros: [
    "Origem",
    "Recurso",
    "Severidade",
    "Etapa",
    "Aviso / item",
    "Mensagem",
    "Quando",
    "",
  ],
};

function SkeletonRows({ cols, rows = 3 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c}>
              <span
                className="skel skel-line"
                style={{ width: c === cols - 1 ? 88 : `${45 + ((r + c) % 5) * 11}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * cmp-erros-table — Tabela de erros de ingestao (Dashboard e Erros).
 *
 * Estados travados: loading (skeleton) e empty (estado vazio "saudavel").
 * O link "Investigar" dispara action-investigar-erro -> /edital/[avisoId].
 */
export function ErrosTable({
  erros,
  variant = "dashboard",
  loading = false,
  emptyTitle,
  emptyDescription,
  onInvestigar,
  footer,
}: {
  erros: Erro[];
  variant?: Variant;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onInvestigar?: (avisoId: string) => void;
  footer?: ReactNode;
}) {
  const columns = COLUMNS[variant];
  const colCount = columns.length;
  const isErros = variant === "erros";

  return (
    <div className={cn("tbl-wrap", isErros && "tbl-scroll")}>
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c || `c-${i}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows cols={colCount} />
          ) : erros.length === 0 ? (
            <tr>
              <td colSpan={colCount}>
                <div className="empty">
                  <Check aria-hidden="true" />
                  <h4>{emptyTitle ?? "Nenhum erro registrado"}</h4>
                  <p>
                    {emptyDescription ??
                      "A ingestão está saudável: coleta, tratamento e indexação sem falhas."}
                  </p>
                </div>
              </td>
            </tr>
          ) : (
            erros.map((e) => {
              const sev = severidadeDescriptor(e.severidade);
              const reprocessando = e.statusReprocesso === "em_andamento";
              return (
                <tr key={e.id}>
                  {variant === "erros" && (
                    <td>
                      <OrigemBadge origem={e.origem} />
                    </td>
                  )}
                  {variant === "erros" && (
                    <td className="sub">{formatRecurso(e.recurso)}</td>
                  )}
                  {variant === "erros" && (
                    <td>
                      <StatusPill state={sev.state} label={sev.label} />
                    </td>
                  )}
                  <td>{e.etapa}</td>
                  <td className="mono">{e.avisoId ?? "—"}</td>
                  <td className="sub">{e.mensagem}</td>
                  <td className="sub tnum">{formatDateTime(e.quando)}</td>
                  <td>
                    <div className="action-col">
                      {reprocessando && (
                        <span className="action-hint" style={{ color: "var(--run)" }}>
                          <Loader2 className="spin" aria-hidden="true" />
                          Reprocessando…
                        </span>
                      )}
                      {/* action-abrir-edital: oculta sem avisoId (sem destino
                          de investigacao). O reprocesso em andamento e apenas
                          refletido; a abertura permanece para inspecao. */}
                      {e.avisoId && onInvestigar ? (
                        <button
                          type="button"
                          className="link"
                          onClick={() => onInvestigar(e.avisoId as string)}
                        >
                          Investigar
                          <ChevronRight aria-hidden="true" />
                        </button>
                      ) : null}
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
