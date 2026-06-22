"use client";

import { type ComponentType, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Inbox, Minus } from "lucide-react";
import type { ExtracaoStatus, TriagemItem } from "@/lib/api/types";
import { formatDataBr, formatDate, formatHoraBr } from "@/lib/format";
import { VereditoBadge } from "@/components/automacao/veredito-badge";

/** Icone + cor + rotulo por estado de extracao de itens do aviso. O proprio
 *  icone e o link para a tela de itens extraidos (status + navegacao num clique). */
const EXTRACAO_META: Record<
  ExtracaoStatus,
  { Icon: ComponentType<{ "aria-hidden"?: boolean }>; cor: string; titulo: string }
> = {
  ok: { Icon: CheckCircle2, cor: "var(--ok)", titulo: "Lista de itens extraída" },
  problema: { Icon: AlertTriangle, cor: "var(--warn)", titulo: "Problema na extração de itens" },
  pendente: { Icon: Clock, cor: "var(--muted)", titulo: "Extração de itens pendente" },
  sem_documento: { Icon: Minus, cor: "var(--muted)", titulo: "Sem documento para extrair itens" },
};

/** Link para a tela de itens extraidos do aviso, levando os metadados da linha
 *  (orgao/UF/edital/Effecti) por query para o cabecalho da pagina. */
function hrefItens(it: TriagemItem): string {
  const qs = new URLSearchParams();
  if (it.orgao) qs.set("orgao", it.orgao);
  if (it.uf) qs.set("uf", it.uf);
  if (it.edital) qs.set("edital", it.edital);
  if (it.effectiId) qs.set("effecti", it.effectiId);
  const sufixo = qs.toString();
  return `/automacao/avisos/${it.avisoId}/itens${sufixo ? `?${sufixo}` : ""}`;
}

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
  // +1 = coluna do link para a tela de itens extraidos pela Lia.
  const colCount = columns.length + 1;
  const isLixeira = variant === "lixeira";
  const isFila = variant === "fila";

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
              const ext = EXTRACAO_META[it.extracao];
              return (
              <tr key={it.avisoId}>
                <td>
                  <Link
                    href={hrefItens(it)}
                    className="btn-icon"
                    style={{ color: ext.cor }}
                    aria-label={`${ext.titulo}. Ver itens extraídos do edital`}
                    title={ext.titulo}
                  >
                    <ext.Icon aria-hidden={true} />
                  </Link>
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
              );
            })
          )}
        </tbody>
      </table>
      {footer}
    </div>
  );
}
