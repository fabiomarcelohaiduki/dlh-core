"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { NAV_MODULES, moduleForPath, screenMeta } from "@/lib/nav";

/**
 * CockpitSubnav — trilha de navegacao (breadcrumbs) + faixa de acoes contextuais
 * acima do container de views internas. E parte do chrome persistente: aparece
 * apenas nas rotas que pertencem a um modulo (onde `moduleForPath` resolve),
 * mantendo as views globais/standalone (Configuracao geral, Conta) sem ruido.
 *
 * As views internas preenchem `cockpit-subnav-actions` via portal/composicao em
 * sprints seguintes; aqui o slot existe e fica reservado.
 */
export function CockpitSubnav() {
  const pathname = usePathname();
  const moduleId = moduleForPath(pathname);
  const mod = NAV_MODULES.find((m) => m.id === moduleId);

  if (!mod) return null;

  const { title } = screenMeta(pathname);

  return (
    <nav className="cockpit-subnav" aria-label="Trilha de navegação">
      <ol className="crumb">
        <li>
          <Link href="/dashboard">Cockpit</Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight />
        </li>
        <li>{mod.label}</li>
        <li aria-hidden="true">
          <ChevronRight />
        </li>
        <li>
          <b aria-current="page">{title}</b>
        </li>
      </ol>
      <div className="cockpit-subnav-actions" />
    </nav>
  );
}
