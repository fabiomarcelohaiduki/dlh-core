import type { ReactNode } from "react";
import type { LixeiraItem } from "@/lib/api/types";
import { TriagemTable } from "@/components/automacao/triagem-table";

/**
 * cmp-lixeira-table — Variante `lixeira` da triagem-table: lista os avisos na
 * carencia com a coluna de data prevista de descarte (descartePrevistoEm), sem
 * a coluna de feedback. Fino wrapper que fixa o variant para a aba Lixeira.
 */
export function LixeiraTable({
  items,
  loading = false,
  emptyTitle,
  emptyDescription,
  footer,
}: {
  items: LixeiraItem[];
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  footer?: ReactNode;
}) {
  return (
    <TriagemTable
      variant="lixeira"
      items={items}
      loading={loading}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      footer={footer}
    />
  );
}
