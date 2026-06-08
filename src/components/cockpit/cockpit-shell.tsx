"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Sidebar } from "@/components/cockpit/sidebar";
import { Topbar } from "@/components/cockpit/topbar";

const COLLAPSE_KEY = "dlh-sidebar-collapsed";

/**
 * Shell do cockpit: grid 236px 1fr (sidebar persistente + conteúdo).
 * Gerencia o estado do drawer da sidebar no mobile e o modo recolhido
 * (somente icones) no desktop, persistido em localStorage.
 */
export function CockpitShell({
  user,
  badges,
  children,
}: {
  user: { email: string };
  badges?: Partial<Record<"erros", number>>;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Restaura a preferencia de recolhimento apos a montagem (evita mismatch SSR).
  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  function toggleCollapse() {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }

  return (
    <div className={cn("app-shell", collapsed && "collapsed")}>
      <div
        className={cn("scrim", menuOpen && "open")}
        onClick={() => setMenuOpen(false)}
        aria-hidden="true"
      />
      <Sidebar
        user={user}
        open={menuOpen}
        badges={badges}
        onNavigate={() => setMenuOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
      />
      <main className="main">
        <Topbar onMenu={() => setMenuOpen((v) => !v)} />
        {children}
      </main>
    </div>
  );
}
