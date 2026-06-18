import { AutomacaoTabsNav } from "@/components/automacao/automacao-tabs-nav";

/**
 * Layout do modulo Automacao: dono do unico wrapper .screen e da barra de
 * abas. As sub-rotas (avisos/lixeira/regras/backtest/aprendizado/config)
 * renderizam apenas o conteudo (fragmentos), sem .screen proprio, para nao
 * duplicar padding. Todo o grupo /automacao/* vive em (cockpit) e exige sessao.
 */
export default function AutomacaoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <section className="screen">
      <AutomacaoTabsNav />
      {children}
    </section>
  );
}
