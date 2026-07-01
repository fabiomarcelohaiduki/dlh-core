import type { Metadata } from "next";
import { RelacionamentosPainel } from "@/components/cockpit/workbench/relacionamentos/RelacionamentosPainel";

export const metadata: Metadata = { title: "Relacionamentos" };

/**
 * Sub-guia "Relacionamentos" dentro do submódulo Coleta (Ingestão).
 * Container thin — o painel é client-side e faz os fetches via hooks
 * (use-relacionamentos-*) que batem nas Edges relacionamentos-* já
 * deployadas em prod. Mantém o padrão das outras sub-abas (Indexação,
 * Escopo, etc.) que são containers sem loader server-side.
 */
export default function IngestaoColetaRelacionamentosPage() {
  return (
    <div data-subpane="coleta-relacionamentos" data-scope="ingestao/coleta/relacionamentos">
      <RelacionamentosPainel />
    </div>
  );
}