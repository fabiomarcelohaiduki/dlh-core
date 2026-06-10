"use client";

import { usePathname } from "next/navigation";
import { Menu, ChevronRight } from "lucide-react";
import { SCREEN_TITLES } from "@/lib/nav";
import { useConexoesFontes } from "@/hooks/use-fontes";
import { cn } from "@/lib/utils";

/** Rotulo acessivel do estado de conexao por cor. */
const ESTADO_LABEL: Record<string, string> = {
  ok: "conectado",
  err: "com erro",
  warn: "atenção",
  run: "coletando",
  idle: "não configurado",
};

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
  const conexoes = useConexoesFontes();

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
        <div className="conns">
          {(conexoes.data ?? []).map((c) => (
            <div
              key={c.tipo}
              className={cn("conn", c.state)}
              title={`${c.label} · ${ESTADO_LABEL[c.state] ?? c.state}`}
            >
              <span className="dot" />
              {c.label}
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}
