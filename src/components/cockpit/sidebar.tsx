"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, RefreshCw } from "lucide-react";
import { NAV_MODULES, type NavModule } from "@/lib/nav";
import { DlhLogo } from "@/components/cockpit/dlh-logo";
import { cn } from "@/lib/utils";

type SidebarProps = {
  open: boolean;
  onNavigate: () => void;
  badges?: Partial<Record<"erros", number>>;
  /** Id do modulo expandido (no maximo 1). */
  expanded: NavModule["id"] | null;
  /** Alterna o modulo expandido (accordion). */
  onToggleModule: (id: NavModule["id"]) => void;
};

/**
 * cmp-sidebar — Navegacao lateral LionClaw em 3 modulos accordion.
 *
 * - Rail (somente icones) que expande no hover ate 288px sem deslocar o
 *   conteudo: a coluna do grid reserva 78px e a `.side` (fixed) sobrepoe; os
 *   labels e submodulos surgem ao expandir (controlado por CSS no `.side:hover`).
 * - Accordion: no maximo 1 modulo expandido por vez (estado controlado pelo
 *   CockpitShell: `expanded` / `onToggleModule`).
 * - Submodulos linkam para as ROTAS REAIS existentes (Strangler Fig).
 * - Drawer + scrim no mobile (classes `.side.open` reusadas do shell).
 */
export function Sidebar({
  open,
  onNavigate,
  badges,
  expanded,
  onToggleModule,
}: SidebarProps) {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    return pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
  }

  return (
    <aside className={cn("side", open && "open")} id="side">
      <div className="side-head">
        <span className="mini-logo" aria-hidden="true">
          <DlhLogo size={44} />
        </span>
        <span className="name">
          DLH Core
          <small>Cockpit LionClaw</small>
        </span>
      </div>

      <Link
        href="/dashboard"
        className={cn("sidebar-cta", isActive("/dashboard") && "active")}
        onClick={onNavigate}
        aria-current={isActive("/dashboard") ? "page" : undefined}
      >
        <RefreshCw aria-hidden="true" />
        <span className="nav-text">Cockpit</span>
      </Link>

      <nav className="primary-nav" aria-label="Navegação principal">
        {NAV_MODULES.map((mod) => {
          const Icon = mod.icon;
          const isOpen = expanded === mod.id;
          const hasActive = mod.items.some((i) => isActive(i.href));
          return (
            <div className={cn("module", isOpen && "is-open")} key={mod.id} data-module={mod.id}>
              <button
                type="button"
                className={cn("module-header", hasActive && "has-active")}
                aria-expanded={isOpen}
                onClick={() => onToggleModule(mod.id)}
              >
                <Icon className="lead" aria-hidden="true" />
                <span className="module-name">{mod.label}</span>
                <ChevronDown className="chev" aria-hidden="true" />
              </button>

              {isOpen && (
                <div className="submodule-list" role="group" aria-label={mod.label}>
                  {mod.items.map((item) => {
                    const active = isActive(item.href);
                    const badge = item.badgeKey ? badges?.[item.badgeKey] : undefined;
                    return (
                      <Link
                        key={item.id}
                        href={item.href}
                        className={cn("submodule", active && "active")}
                        aria-current={active ? "page" : undefined}
                        onClick={onNavigate}
                      >
                        <span className="nav-text">{item.label}</span>
                        {badge ? <span className="nav-badge">{badge}</span> : null}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
