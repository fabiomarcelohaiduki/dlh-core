import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/cockpit/ui/empty-state";

/** CSS custom property `--i` consumida pela cascata `.stat-rise` (globals.css). */
type StaggerStyle = CSSProperties & { "--i"?: number };

/**
 * modulo-card — card de modulo data-driven do cockpit (SPEC 4.3.3 / 4.5).
 *
 * Na Fase 0 nasce como shell configuravel: renderiza titulo + area de metrica
 * em empty-state honesto (`card-no-data`) enquanto nenhuma metrica real esta
 * plugada. Quando um pipeline futuro fornecer `metric`, o card passa a exibi-la
 * sem mudar a casca. NAO faz nenhuma leitura de dado de negocio aqui.
 *
 * `hidden` materializa o estado `card-hidden`: o card e omitido por completo
 * quando configurado como invisivel (cardsCfg.setOn(scope, false)).
 */
export function ModuloCard({
  title,
  description,
  icon,
  href,
  metric,
  hidden = false,
  index,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  /** Quando fornecido, o card vira um link para a tela do modulo. */
  href?: string;
  /** Metrica real (Fase futura). Ausente => empty-state `card-no-data`. */
  metric?: ReactNode;
  /** Estado `card-hidden`: nao renderiza nada. */
  hidden?: boolean;
  /** Posicao no grid; alimenta a cascata de entrada `.stat-rise` via `--i`. */
  index?: number;
}) {
  // Estado card-hidden: o card configurado como invisivel some da view.
  if (hidden) return null;

  const style: StaggerStyle | undefined =
    index != null ? { "--i": index } : undefined;
  const hasData = metric != null;

  const body = (
    <article
      className="card modulo-card"
      style={style}
      data-state={hasData ? "card-data" : "card-no-data"}
    >
      <div className="modulo-card-head">
        {icon != null ? <span className="modulo-card-icon">{icon}</span> : null}
        <div className="modulo-card-titles">
          <h3>{title}</h3>
          {description != null ? <p>{description}</p> : null}
        </div>
      </div>
      <div className="modulo-card-metric">
        {hasData ? metric : <EmptyState />}
      </div>
    </article>
  );

  if (href != null) {
    return (
      <Link href={href} className={cn("modulo-card-link")}>
        {body}
      </Link>
    );
  }
  return body;
}
