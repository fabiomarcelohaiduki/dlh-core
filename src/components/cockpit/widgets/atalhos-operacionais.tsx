import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { EmptyState } from "@/components/cockpit/ui/empty-state";

/**
 * atalhos-operacionais — painel fixo do cockpit (SPEC 4.3.3 / 4.6).
 *
 * Na Fase 0 nao ha atalhos configurados, entao a lista renderiza em
 * empty-state honesto. Mantemos um unico atalho estatico para a Configuracao
 * (sem leitura de dado), espelhando "Abrir configuracao" do Design Lock.
 */
export function AtalhosOperacionais() {
  return (
    <section
      className="card cockpit-widget"
      data-cockpit-widget="atalhos-operacionais"
      aria-label="Atalhos operacionais"
    >
      <div className="cockpit-widget-head">
        <div className="cockpit-widget-titles">
          <h3>Atalhos operacionais</h3>
          <p>Acessos rápidos do cockpit.</p>
        </div>
      </div>
      <EmptyState hint="Configure atalhos para suas rotinas mais frequentes." />
      <Link href="/configuracoes-empresa" className="link cockpit-widget-link">
        Abrir configuração
        <ArrowRight aria-hidden="true" />
      </Link>
    </section>
  );
}
