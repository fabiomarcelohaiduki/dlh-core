"use client";

import { usePathname } from "next/navigation";
import { Menu, ChevronRight } from "lucide-react";
import { SCREEN_TITLES } from "@/lib/nav";

function currentTitle(pathname: string | null): string {
  if (!pathname) return "Cockpit";
  if (pathname.startsWith("/edital")) return SCREEN_TITLES["/edital"];
  const match = Object.keys(SCREEN_TITLES).find(
    (href) => pathname === href || pathname.startsWith(`${href}/`),
  );
  return match ? SCREEN_TITLES[match] : "Cockpit";
}

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const pathname = usePathname();
  const title = currentTitle(pathname);

  return (
    <header className="topbar">
      <button className="menu-btn" type="button" onClick={onMenu} aria-label="Abrir menu">
        <Menu aria-hidden="true" />
      </button>
      <div className="crumb">
        <span>Cockpit</span>
        <ChevronRight aria-hidden="true" />
        <b>{title}</b>
      </div>
      <div className="right">
        <div className="conn">
          <span className="dot" />
          Effecti · conectado
        </div>
      </div>
    </header>
  );
}
