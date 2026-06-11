import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

type MetaTone = "default" | "up" | "warn" | "err";

/** CSS custom property `--i` consumida pela cascata `.stat-rise` (globals.css). */
type StaggerStyle = CSSProperties & { "--i"?: number };

/**
 * cmp-stat-card — Card de KPI do Dashboard.
 *
 * `value` aceita ReactNode (numero com unidade ou um StatusPill, como no
 * card de healthcheck). No estado loading renderiza skeletons no lugar do
 * valor e do meta, preservando a altura do card (sem layout shift).
 */
export function StatCard({
  icon,
  label,
  value,
  meta,
  metaTone = "default",
  pill = false,
  loading = false,
  index,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  metaTone?: MetaTone;
  /** Quando o valor e um StatusPill, alinha como no card de healthcheck. */
  pill?: boolean;
  loading?: boolean;
  /** Posicao no grid; alimenta a cascata de entrada `.stat-rise` via `--i`. */
  index?: number;
}) {
  const style: StaggerStyle | undefined =
    index != null ? { "--i": index } : undefined;
  return (
    <div className="card stat" style={style}>
      <div className="k">
        {icon}
        {label}
      </div>

      {loading ? (
        <>
          {pill ? (
            <span className="skel skel-pill" />
          ) : (
            <span className="skel skel-line" style={{ height: 24, width: "55%" }} />
          )}
          <div className="meta" style={{ marginTop: 11 }}>
            <span className="skel skel-line" style={{ height: 11, width: "70%" }} />
          </div>
        </>
      ) : (
        <>
          <div className={cn("v", pill && "pill-v")}>{value}</div>
          {meta != null && (
            <div className={cn("meta", metaTone !== "default" && metaTone)}>{meta}</div>
          )}
        </>
      )}
    </div>
  );
}
