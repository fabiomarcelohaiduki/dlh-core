"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * cmp-cadastros-tabs-nav — Abas (por rota) do menu Cadastros: Produtos e
 * Linhas de produtos. Cada aba e um Link real (sub-rota propria, carrega so os
 * seus dados); o estado ativo deriva do pathname. Mesmo padrao visual
 * segmented/role=tablist da Ingestão e da Automação.
 */
const TABS: { href: string; label: string }[] = [
  { href: "/cadastros/produtos", label: "Produtos" },
  { href: "/cadastros/linhas-produtos", label: "Linhas de produtos" },
];

export function CadastrosTabsNav() {
  const pathname = usePathname();

  return (
    <div
      className="filter-group segmented"
      role="tablist"
      aria-label="Seção dos cadastros"
      style={{ display: "inline-flex", margin: "4px 0 16px" }}
    >
      {TABS.map((t) => {
        const active = pathname === t.href || pathname?.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={active}
            className={cn("btn", "btn-sm", active && "btn-primary")}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
