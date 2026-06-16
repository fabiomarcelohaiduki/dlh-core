import { IngestaoTabsNav } from "@/components/cockpit/ingestao-tabs-nav";

/**
 * Layout do menu Ingestão: dono do unico wrapper .screen e da barra de abas.
 * As sub-rotas (execucoes/extracao/configuracao/fontes) renderizam apenas o
 * conteudo (fragmentos), sem .screen proprio, para nao duplicar padding.
 */
export default function IngestaoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <section className="screen">
      <IngestaoTabsNav />
      {children}
    </section>
  );
}
