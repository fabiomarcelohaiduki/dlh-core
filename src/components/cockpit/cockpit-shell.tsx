"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Sidebar } from "@/components/cockpit/sidebar";
import { Topbar } from "@/components/cockpit/topbar";

/**
 * Shell do cockpit: grid 236px 1fr (sidebar persistente + conteúdo).
 * Gerencia o estado do drawer da sidebar no mobile.
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

  return (
    <div className="app-shell">
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
      />
      <main className="main">
        <Topbar onMenu={() => setMenuOpen((v) => !v)} />
        {children}
      </main>
    </div>
  );
}
