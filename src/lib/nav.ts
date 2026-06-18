import type { ComponentType, SVGProps } from "react";
import {
  LayoutDashboard,
  Database,
  Braces,
  Layers,
  Package,
  Store,
  Building2,
  Sparkles,
  Trash2,
  Gavel,
  Target,
  GraduationCap,
  SlidersHorizontal,
} from "lucide-react";

export type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  badgeKey?: "erros";
};

export type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

/**
 * Navegacao persistente travada pelo Design Lock (design-contract.json).
 * Itens primarios em 3 grupos (Cerebro, Engenharia, Administracao). A
 * config de ingestao vive dentro de Fontes (vinculada a fonte). "Detalhe do
 * edital" NAO aparece no menu. 1 item de menu = 1 tela.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "cerebro",
    label: "Cérebro",
    items: [
      { id: "nav-dashboard", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { id: "nav-ingestao", label: "Ingestão", href: "/ingestao", icon: Database },
    ],
  },
  {
    id: "engenharia",
    label: "Engenharia",
    items: [
      { id: "nav-produtos", label: "Produtos", href: "/produtos", icon: Layers },
      { id: "nav-insumos", label: "Lista de Materiais", href: "/insumos", icon: Package },
      { id: "nav-revenda", label: "Revenda", href: "/revenda", icon: Store },
    ],
  },
  {
    id: "automacao",
    label: "Automação",
    items: [
      { id: "nav-automacao-triagem", label: "Triagem", href: "/automacao/avisos", icon: Sparkles },
      {
        id: "nav-automacao-lixeira",
        label: "Lixeira",
        href: "/automacao/avisos/lixeira",
        icon: Trash2,
      },
      {
        id: "nav-automacao-regras",
        label: "Regras",
        href: "/automacao/avisos/regras",
        icon: Gavel,
      },
      {
        id: "nav-automacao-backtest",
        label: "Backtest",
        href: "/automacao/avisos/backtest",
        icon: Target,
      },
      {
        id: "nav-automacao-aprendizado",
        label: "Aprendizado",
        href: "/automacao/avisos/aprendizado",
        icon: GraduationCap,
      },
      {
        id: "nav-automacao-config",
        label: "Configuração",
        href: "/automacao/avisos/config",
        icon: SlidersHorizontal,
      },
    ],
  },
  {
    id: "administracao",
    label: "Administração",
    items: [
      { id: "nav-api", label: "API LLM-ready", href: "/api", icon: Braces },
      {
        id: "nav-configuracoes-empresa",
        label: "Configurações da empresa",
        href: "/configuracoes-empresa",
        icon: Building2,
      },
    ],
  },
];

/** Mapa rota -> titulo para breadcrumb/metadata. */
export const SCREEN_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/ingestao/coleta": "Coleta",
  "/ingestao/extracao": "Extração",
  "/ingestao/indexacao": "Indexação",
  "/ingestao/fontes": "Fontes e credenciais",
  "/ingestao": "Ingestão",
  "/erros": "Erros",
  "/api": "API LLM-ready",
  "/configuracoes-empresa": "Configurações da empresa",
  "/produtos": "Produtos",
  "/insumos": "Materiais",
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
