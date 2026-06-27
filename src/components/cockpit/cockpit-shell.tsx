"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Sidebar } from "@/components/cockpit/sidebar";
import { Topbar } from "@/components/cockpit/topbar";
import { CockpitSubnav } from "@/components/cockpit/cockpit-subnav";
import { OrgBanner } from "@/components/cockpit/org-banner";
import { ReduceMotionSync } from "@/components/cockpit/config/reduce-motion-sync";
import { PreferencesSync } from "@/components/cockpit/config/preferences-sync";
import { SessionGuard } from "@/components/cockpit/session-guard";
import { SessaoProvider } from "@/components/cockpit/sessao-provider";
import { NAV_MODULES, moduleForPath, type NavModule } from "@/lib/nav";
import type { FonteConexao } from "@/lib/status";

const EXPANDED_KEY = "lionclaw.nav-expanded";

/** Escrita tolerante no localStorage (EC-08): nunca derruba a UI se indisponivel. */
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage indisponivel (modo privado/cota): fallback silencioso */
  }
}

/**
 * Shell do cockpit: grid sidebar + conteudo (SPEC 4.3.2). Persistente entre as
 * views. Gerencia:
 *  - drawer da sidebar no mobile (`menuOpen`) + scrim;
 *  - accordion da sidebar (1 modulo expandido por vez), auto-expandindo o
 *    modulo da rota ativa e persistindo a escolha (`nav-expanded-<modulo>`).
 *
 * No desktop a sidebar e um rail (somente icones) que expande no hover; esse
 * comportamento vive no CSS (`.side:hover`), sem estado React.
 */
export function CockpitShell({
  user,
  badges,
  conexoes,
  children,
}: {
  user: { email: string };
  badges?: Partial<Record<"erros", number>>;
  conexoes?: FonteConexao[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState<NavModule["id"] | null>(null);

  // Restaura preferencias apos a montagem (evita mismatch SSR).
  useEffect(() => {
    // EC-08: leitura tolerante do localStorage. Uma chave corrompida/ilegivel
    // (valor que nao corresponde a um modulo valido, ou storage indisponivel)
    // cai em fallback silencioso para o modulo da rota ativa.
    let stored: NavModule["id"] | null = null;
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      stored = NAV_MODULES.some((m) => m.id === raw)
        ? (raw as NavModule["id"])
        : null;
    } catch {
      stored = null;
    }
    // Prioriza o modulo da rota ativa; cai na ultima escolha persistida valida.
    setExpanded(moduleForPath(pathname) ?? stored ?? "ingestao");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ao navegar, abre automaticamente o modulo que contem a rota ativa.
  useEffect(() => {
    const mod = moduleForPath(pathname);
    if (mod) setExpanded(mod);
  }, [pathname]);

  function toggleModule(id: NavModule["id"]) {
    setExpanded((cur) => {
      const next = cur === id ? null : id;
      if (next) safeSet(EXPANDED_KEY, next);
      return next;
    });
  }

  return (
    <SessaoProvider>
      <div className="app-shell">
        <ReduceMotionSync />
        <PreferencesSync />
        <SessionGuard />
        <div
          className={cn("scrim", menuOpen && "open")}
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
        <Sidebar
          open={menuOpen}
          badges={badges}
          onNavigate={() => setMenuOpen(false)}
          expanded={expanded}
          onToggleModule={toggleModule}
        />
        <main className="main">
          <Topbar onMenu={() => setMenuOpen((v) => !v)} user={user} conexoes={conexoes} />
          <CockpitSubnav />
          <OrgBanner />
          {children}
        </main>
      </div>
    </SessaoProvider>
  );
}
