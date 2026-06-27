import type { Metadata } from "next";
import { AtividadeGlobalTimeline } from "@/components/cockpit/atividade-global-timeline";

export const metadata: Metadata = { title: "Atividade global" };

/**
 * View atividade-global (/atividade-global).
 *
 * Casca server + metadata; o conteúdo (timeline com filtro Todos/Pendências/
 * Erros, estado vazio honesto e estado de erro de leitura — EC-21) é
 * client-side em AtividadeGlobalTimeline. Acessível pelo activityButton da
 * Topbar.
 */
export default function AtividadeGlobalPage() {
  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Atividade global</h2>
          <p>Sinais recentes emitidos pelas automações e ingestão do ambiente.</p>
        </div>
      </div>

      <AtividadeGlobalTimeline />
    </section>
  );
}
