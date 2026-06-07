"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { LogOut } from "lucide-react";
import { NAV_GROUPS } from "@/lib/nav";
import { logout } from "@/app/actions/auth";
import { cn } from "@/lib/utils";

type SidebarProps = {
  user: { email: string };
  open: boolean;
  onNavigate: () => void;
  badges?: Partial<Record<"erros", number>>;
};

function initialsFromEmail(email: string): string {
  const handle = email.split("@")[0] ?? "";
  const parts = handle.split(/[.\-_]/).filter(Boolean);
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : handle.slice(0, 2);
  return chars.toUpperCase() || "DL";
}

/** cmp-sidebar — Navegação persistente travada (Design Lock). */
export function Sidebar({ user, open, onNavigate, badges }: SidebarProps) {
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  function handleLogout() {
    startTransition(async () => {
      await logout();
    });
  }

  return (
    <aside className={cn("side", open && "open")} id="side">
      <div className="side-head">
        <span className="glyph">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z" />
            <path d="M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7" />
            <path d="M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5" />
          </svg>
        </span>
        <span className="name">
          DLH Core
          <small>Cockpit de ingestão</small>
        </span>
      </div>

      <nav>
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.id}>
            <div className="label">{group.label}</div>
            {group.items.map((item) => {
              const active =
                pathname === item.href ||
                (pathname?.startsWith(`${item.href}/`) ?? false);
              const Icon = item.icon;
              const badge = item.badgeKey ? badges?.[item.badgeKey] : undefined;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={cn("nav-link", active && "active")}
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                >
                  <Icon aria-hidden="true" />
                  {item.label}
                  {badge ? <span className="nav-badge">{badge}</span> : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="side-foot">
        <div className="user-row">
          <div className="avatar">{initialsFromEmail(user.email)}</div>
          <div className="who">
            <b>Núcleo DLH</b>
            <span>{user.email}</span>
          </div>
          <button
            type="button"
            title="Sair"
            onClick={handleLogout}
            disabled={isPending}
            aria-label="Sair do cockpit"
          >
            <LogOut aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}
