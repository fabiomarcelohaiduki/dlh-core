import type { ComponentType, SVGProps } from "react";
import {
  LayoutDashboard,
  Activity,
  FileText,
  TriangleAlert,
  KeyRound,
  Braces,
  Sparkles,
  Layers,
  Package,
  SlidersHorizontal,
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
 * Itens primarios em 3 grupos (Monitoramento, Produtos, Administracao). A
 * config de ingestao vive dentro de Fontes (vinculada a fonte). "Detalhe do
 * edital" NAO aparece no menu. 1 item de menu = 1 tela.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "monitoramento",
    label: "Monitoramento",
    items: [
      { id: "nav-dashboard", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { id: "nav-execucoes", label: "Execuções", href: "/execucoes", icon: Activity },
      { id: "nav-extracao", label: "Extração", href: "/extracao", icon: FileText },
      { id: "nav-erros", label: "Erros", href: "/erros", icon: TriangleAlert, badgeKey: "erros" },
    ],
  },
  {
    id: "produtos",
    label: "Produtos",
    items: [
      { id: "nav-produtos", label: "Linha de produtos", href: "/produtos", icon: Layers },
      { id: "nav-insumos", label: "Lista de Materiais", href: "/insumos", icon: Package },
      {
        id: "nav-parametros-custo",
        label: "Parâmetros de custo",
        href: "/parametros-custo",
        icon: SlidersHorizontal,
      },
      { id: "nav-revenda", label: "Revenda", href: "/revenda", icon: Store },
    ],
  },
  {
    id: "administracao",
    label: "Administração",
    items: [
      { id: "nav-fontes", label: "Fontes e credenciais", href: "/fontes", icon: KeyRound },
      { id: "nav-indexacao", label: "Indexação", href: "/indexacao", icon: Sparkles },
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
  "/execucoes": "Execuções",
  "/extracao": "Extração",
  "/erros": "Erros",
  "/fontes": "Fontes e credenciais",
  "/indexacao": "Indexação",
  "/api": "API LLM-ready",
  "/configuracoes-empresa": "Configurações da empresa",
  "/produtos": "Linha de produtos",
  "/insumos": "Materiais",
  "/parametros-custo": "Parâmetros de custo",
  "/revenda": "Revenda",
  "/edital": "Detalhe do edital",
};
