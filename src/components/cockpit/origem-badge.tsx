import { normalizeOrigem, origemLabel } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * cmp-origem-badge — Badge da origem (Effecti x Nomus x Gmail) das telas
 * multi-origem.
 *
 * Reaproveita o tema vigente (tokens --accent / --run / --ok): Effecti no tom
 * da marca (accent), Nomus no tom de processamento (run) e Gmail no tom de
 * sucesso (ok). A origem crua e normalizada (fonte da execucao ou origem do
 * erro) antes de mapear a cor.
 */
export function OrigemBadge({
  origem,
  className,
}: {
  origem: string | null | undefined;
  className?: string;
}) {
  const key = normalizeOrigem(origem);
  return <span className={cn("tag", key, className)}>{origemLabel(key)}</span>;
}
