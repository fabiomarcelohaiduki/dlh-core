"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * cmp-ingestao-tabs-nav — Abas (por rota) do menu Ingestão. Reune as quatro
 * telas de coleta/extracao num so lugar: Execução, Extração, Configuração de
 * extração e Fontes e credenciais. Cada aba e um Link real (sub-rota propria,
 * carrega so os seus dados); o estado ativo deriva do pathname. Mesmo padrao
 * visual segmented/role=tablist do detalhe de produto.
 */
const TABS: { href: string; label: string }[] = [
  { href: "/ingestao/execucoes", label: "Execução" },
  { href: "/ingestao/extracao", label: "Extração" },
  { href: "/ingestao/configuracao", label: "Configuração de extração" },
  { href: "/ingestao/fontes", label: "Fontes e credenciais" },
];

export function IngestaoTabsNav() {
  const pathname = usePathname();

  return (
    <div
      className="filter-group segmented"
      role="tablist"
      aria-label="Seção da ingestão"
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
