import type { ComponentType, SVGProps } from "react";
import {
  LayoutDashboard,
  Activity,
  FileText,
  TriangleAlert,
  KeyRound,
  Braces,
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
 * 5 itens primarios em 2 grupos. A config de ingestao vive dentro de Fontes
 * (vinculada a fonte). "Detalhe do edital" NAO aparece no menu.
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
    id: "administracao",
    label: "Administração",
    items: [
      { id: "nav-fontes", label: "Fontes e credenciais", href: "/fontes", icon: KeyRound },
      { id: "nav-api", label: "API LLM-ready", href: "/api", icon: Braces },
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
  "/api": "API LLM-ready",
  "/edital": "Detalhe do edital",
};
