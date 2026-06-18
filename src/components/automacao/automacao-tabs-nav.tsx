"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * cmp-automacao-tabs-nav — Abas (por rota) do modulo Automacao: Fila, Triagem,
 * Lixeira, Regras, Backtest, Aprendizado e Configuracao. Cada aba e um Link
 * real (sub-rota propria, carrega so os seus dados); o estado ativo deriva do
 * pathname. Mesmo padrao visual segmented/role=tablist do molde Ingestao.
 *
 * A aba Triagem (/automacao/avisos) e prefixo das demais; por isso o ativo dela
 * exige match EXATO, evitando ficar ativa em /automacao/avisos/lixeira etc.
 */
const TABS: { href: string; label: string; exact?: boolean }[] = [
  { href: "/automacao/fila", label: "Fila" },
  { href: "/automacao/avisos", label: "Triagem", exact: true },
  { href: "/automacao/avisos/lixeira", label: "Lixeira" },
  { href: "/automacao/avisos/regras", label: "Regras" },
  { href: "/automacao/avisos/backtest", label: "Backtest" },
  { href: "/automacao/avisos/aprendizado", label: "Aprendizado" },
  { href: "/automacao/avisos/config", label: "Configuração" },
];

export function AutomacaoTabsNav() {
  const pathname = usePathname();

  return (
    <div
      className="filter-group segmented"
      role="tablist"
      aria-label="Seção da automação"
      style={{ display: "inline-flex", margin: "4px 0 16px" }}
    >
      {TABS.map((t) => {
        const active = t.exact
          ? pathname === t.href
          : pathname === t.href || pathname?.startsWith(`${t.href}/`);
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
