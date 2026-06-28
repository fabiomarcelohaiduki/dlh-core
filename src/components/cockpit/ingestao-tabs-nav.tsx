"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * cmp-ingestao-tabs-nav — Abas (por rota) do menu Ingestão: Coleta, Extração,
 * Indexação e Fontes e credenciais. Os parâmetros da extração vivem dentro da
 * aba Extração (botão "Parâmetros"). Cada aba e um Link real (sub-rota propria,
 * carrega so os seus dados); o estado ativo deriva do pathname. Mesmo padrao
 * visual segmented/role=tablist do detalhe de produto.
 */
const TABS: { href: string; label: string }[] = [
  { href: "/ingestao/coleta", label: "Coleta" },
  { href: "/ingestao/extracao", label: "Extração" },
  { href: "/ingestao/indexacao", label: "Indexação" },
  { href: "/ingestao/fontes", label: "Fontes e credenciais" },
];

export function IngestaoTabsNav() {
  const pathname = usePathname();

  return (
    <div className="screen-tabs" role="tablist" aria-label="Seção da ingestão">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname?.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={active}
            className={cn("screen-tab", active && "is-active")}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
