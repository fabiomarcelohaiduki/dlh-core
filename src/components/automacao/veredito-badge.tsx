import type { Veredito } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/**
 * cmp-veredito-badge — Badge do veredito da triagem (util x duvida x lixo).
 *
 * Mapeia o estado para os tokens travados via classes `.tag.<veredito>`
 * (util=verde, duvida=ambar destacado, lixo=vermelho suave). Exibe a confianca
 * como percentual inteiro (confianca*100 arredondado) e "—" quando nula (E11).
 * Veredito ausente cai no `.tag` neutro com "—".
 */
const LABELS: Record<Veredito, string> = {
  util: "Útil",
  duvida: "Dúvida",
  lixo: "Lixo",
};

export function VereditoBadge({
  veredito,
  confianca,
  className,
}: {
  veredito: Veredito | null;
  confianca: number | null;
  className?: string;
}) {
  // E11: confianca nula -> "—"; caso contrario percentual inteiro.
  const pct = confianca != null ? `${Math.round(confianca * 100)}%` : "—";

  if (!veredito) {
    return <span className={cn("tag", className)}>—</span>;
  }

  return (
    <span className={cn("tag", veredito, className)}>
      {LABELS[veredito]} · {pct}
    </span>
  );
}
