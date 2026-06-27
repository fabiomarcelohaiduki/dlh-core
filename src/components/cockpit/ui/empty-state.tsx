import type { ReactNode } from "react";
import { CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * empty-state — placeholder honesto para o estado `card-no-data` (SPEC 4.5).
 *
 * Na Fase 0 do cockpit os cards e paineis nascem como shells configuraveis
 * sem metrica real plugada: em vez de inventar numeros ou esconder a area, o
 * componente declara explicitamente "Sem dado configurado". Cada pipeline de
 * tela pluga a metrica depois (ver SPEC 4.6).
 */
export function EmptyState({
  message = "Sem dado configurado",
  hint,
  icon,
  className,
}: {
  /** Mensagem principal do estado vazio. Default: "Sem dado configurado". */
  message?: string;
  /** Linha de apoio opcional explicando como o dado aparece. */
  hint?: ReactNode;
  /** Icone opcional; cai num tracejado neutro quando ausente. */
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("card-no-data", className)}
      data-state="card-no-data"
      role="status"
    >
      <span className="cnd-icon">{icon ?? <CircleDashed aria-hidden="true" />}</span>
      <p className="cnd-msg">{message}</p>
      {hint != null ? <p className="cnd-hint">{hint}</p> : null}
    </div>
  );
}
