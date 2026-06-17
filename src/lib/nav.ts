import type { ComponentType, SVGProps } from "react";
import {
  LayoutDashboard,
  Database,
  Braces,
  Layers,
  Package,
  Store,
  Building2,
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
  "/edital": "Detalhe do edital",
};
