import type { ComponentType, SVGProps } from "react";
import { Inbox, Database, Zap } from "lucide-react";

/** Submodulo de navegacao (1 item = 1 tela, aponta para rota real existente). */
export type NavSubmodule = {
  id: string;
  label: string;
  href: string;
  badgeKey?: "erros";
};

/** Modulo de navegacao (accordion). 3 modulos no total (delta-07/14). */
export type NavModule = {
  id: "ingestao" | "cadastros" | "automacoes";
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  items: NavSubmodule[];
};

/**
 * Navegacao lateral em 3 modulos accordion (SPEC 4.8.3 / delta-07/14).
 *
 * Padrao Strangler Fig: a casca LionClaw envolve o app existente. Os submodulos
 * apontam para as ROTAS REAIS ja implementadas (`/ingestao/*`, `/automacao/*`,
 * etc.) — nenhuma tela legada e reconstruida nesta fase. A SPEC modela rotas
 * como `/coleta`; o codigo real usa `/ingestao/coleta` e essa e a forma
 * canonica adotada (SPEC 4.9.3, nota de divergencia).
 *
 * delta-14: o submodulo "Registros" NAO existe em Cadastros.
 */
export const NAV_MODULES: NavModule[] = [
  {
    id: "ingestao",
    label: "Ingestão",
    icon: Inbox,
    items: [
      { id: "nav-coleta", label: "Coleta", href: "/ingestao/coleta" },
      { id: "nav-extracao", label: "Extração", href: "/ingestao/extracao" },
      { id: "nav-indexacao", label: "Indexação", href: "/ingestao/indexacao" },
      { id: "nav-erros", label: "Erros", href: "/erros", badgeKey: "erros" },
      { id: "nav-api", label: "API LLM-ready", href: "/api" },
      { id: "nav-ingestao-config", label: "Configurações do módulo", href: "/ingestao/configuracoes-do-modulo" },
    ],
  },
  {
    id: "cadastros",
    label: "Cadastros",
    icon: Database,
    items: [
      { id: "nav-produtos", label: "Produtos", href: "/cadastros/produtos" },
      { id: "nav-linhas-produtos", label: "Linhas de produtos", href: "/cadastros/linhas-produtos" },
      { id: "nav-insumos", label: "Lista de Materiais", href: "/insumos" },
      { id: "nav-parametros-custo", label: "Parâmetros de custo", href: "/parametros-custo" },
      { id: "nav-revenda", label: "Revenda", href: "/revenda" },
      { id: "nav-cadastros-config", label: "Configurações do módulo", href: "/cadastros/configuracoes-do-modulo" },
    ],
  },
  {
    id: "automacoes",
    label: "Automações",
    icon: Zap,
    items: [
      { id: "nav-automacao-triagem", label: "Triagem", href: "/automacao/avisos" },
      { id: "nav-automacao-lixeira", label: "Lixeira", href: "/automacao/avisos/lixeira" },
      { id: "nav-automacao-regras", label: "Regras", href: "/automacao/avisos/regras" },
      { id: "nav-automacao-backtest", label: "Backtest", href: "/automacao/avisos/backtest" },
      { id: "nav-automacao-aprendizado", label: "Aprendizado", href: "/automacao/avisos/aprendizado" },
      { id: "nav-automacao-config", label: "Configuração", href: "/automacao/avisos/config" },
      { id: "nav-automacoes-config", label: "Configurações do módulo", href: "/automacoes/configuracoes-do-modulo" },
    ],
  },
];

/**
 * Resolve o id do modulo que contem a rota ativa (para auto-expandir o
 * accordion). Casa pelo prefixo MAIS LONGO do href do submodulo.
 */
export function moduleForPath(pathname: string | null): NavModule["id"] | null {
  if (!pathname) return null;
  let best: { moduleId: NavModule["id"]; len: number } | null = null;
  for (const mod of NAV_MODULES) {
    for (const item of mod.items) {
      const match = pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (match && (!best || item.href.length > best.len)) {
        best = { moduleId: mod.id, len: item.href.length };
      }
    }
  }
  return best?.moduleId ?? null;
}

/** Mapa rota -> titulo para a topbar/metadata. */
export const SCREEN_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/ingestao/coleta": "Coleta",
  "/ingestao/extracao": "Extração",
  "/ingestao/indexacao": "Indexação",
  "/ingestao": "Ingestão",
  "/erros": "Erros",
  "/api": "API LLM-ready",
  "/configuracoes-empresa": "Configurações da empresa",
  "/configuracao-geral": "Configuração geral",
  "/configuracao": "Configuração do cockpit",
  "/conta-google": "Conta",
  "/atividade-global": "Atividade global",
  "/integracoes-global": "Integrações",
  "/ingestao/configuracoes-do-modulo": "Configurações do módulo",
  "/cadastros/configuracoes-do-modulo": "Configurações do módulo",
  "/automacoes/configuracoes-do-modulo": "Configurações do módulo",
  "/cadastros/produtos": "Produtos",
  "/cadastros/linhas-produtos": "Linhas de produtos",
  "/produtos": "Produtos",
  "/insumos": "Lista de Materiais",
  "/parametros-custo": "Parâmetros de custo",
  "/revenda": "Revenda",
  "/automacao/avisos/lixeira": "Lixeira",
  "/automacao/avisos/regras": "Regras",
  "/automacao/avisos/backtest": "Backtest",
  "/automacao/avisos/aprendizado": "Aprendizado",
  "/automacao/avisos/config": "Configuração",
  "/automacao/avisos": "Triagem",
  "/automacao": "Automação",
  "/edital": "Detalhe do edital",
};

/** Subtitulo opcional por rota (contexto na topbar). */
export const SCREEN_SUBTITLES: Record<string, string> = {
  "/dashboard": "Estado geral das automações, ingestão de documentos e registros operacionais.",
  "/ingestao/coleta": "Execuções dos agendamentos de coleta e itens capturados por fonte.",
  "/cadastros/produtos": "Itens cadastrados para licitações, organizados por linha de produtos.",
  "/cadastros/linhas-produtos": "Famílias que agrupam os produtos do catálogo por segmento.",
  "/produtos": "Catálogo de linhas, produtos e SKUs.",
  "/insumos": "Materiais, preços e composição de custo.",
  "/automacao/avisos": "Triagem assistida de avisos coletados.",
  "/configuracoes-empresa": "Dados institucionais e logomarca da DLH.",
  "/configuracao-geral": "Preferências de todo o ambiente, tema e acessibilidade.",
  "/configuracao": "Visibilidade e ordem dos cards de módulo e painéis fixos do cockpit.",
  "/conta-google": "Sessão autenticada com Google pelo Supabase Auth.",
  "/atividade-global": "Sinais recentes emitidos pelas automações e ingestão do ambiente.",
  "/integracoes-global": "Conectores, autenticações e provedores externos do cockpit.",
  "/ingestao/configuracoes-do-modulo": "Estado do módulo e blocos de layout por tela.",
  "/cadastros/configuracoes-do-modulo": "Estado do módulo e blocos de layout por tela.",
  "/automacoes/configuracoes-do-modulo": "Estado do módulo e blocos de layout por tela.",
};

/** Resolve titulo + subtitulo da rota ativa para a topbar. */
export function screenMeta(pathname: string | null): { title: string; subtitle?: string } {
  if (!pathname) return { title: "Cockpit" };
  if (pathname.startsWith("/edital")) return { title: SCREEN_TITLES["/edital"] };
  const match = Object.keys(SCREEN_TITLES)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!match) return { title: "Cockpit" };
  return { title: SCREEN_TITLES[match], subtitle: SCREEN_SUBTITLES[match] };
}
