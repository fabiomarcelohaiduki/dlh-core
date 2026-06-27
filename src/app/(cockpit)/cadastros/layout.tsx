import { CadastrosTabsNav } from "@/components/cockpit/cadastros-tabs-nav";

/**
 * Layout do menu Cadastros: dono do unico wrapper .screen e da barra de abas.
 * As sub-rotas (produtos/linhas-produtos/configuracoes-do-modulo) renderizam
 * apenas o conteudo (fragmentos), sem .screen proprio, para nao duplicar
 * padding. Mesmo padrao da Ingestão e da Automação.
 */
export default function CadastrosLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <section className="screen">
      <CadastrosTabsNav />
      {children}
    </section>
  );
}
