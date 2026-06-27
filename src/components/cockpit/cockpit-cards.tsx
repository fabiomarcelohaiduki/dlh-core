"use client";

// =====================================================================
// cockpit-cards — cards de módulo do cockpit, governados por bloco_config.
//
// Lê o snapshot de `bloco_config` (tipo `card`) e aplica visibilidade/ordem
// definidas em "Configuração do cockpit". Ocultar um card aqui materializa o
// estado `card-hidden` (ModuloCard retorna null). Sem config persistida, cai
// no catálogo canônico (COCKPIT_CARDS) na ordem natural.
// =====================================================================

import { useMemo, type ReactNode } from "react";
import { Boxes, Database, Zap } from "lucide-react";
import { COCKPIT_CARDS, type ModuloId } from "@/lib/cockpit-config";
import { makeScopeConfig } from "@/lib/engines/block-vis";
import { useBlocoConfig } from "@/hooks/use-configuracao";
import { ModuloCard } from "@/components/cockpit/cards/modulo-card";

/** Ícone por módulo (espelha NAV_MODULES / cockpit-view legado). */
const CARD_ICONS: Record<ModuloId, ReactNode> = {
  ingestao: <Database aria-hidden="true" />,
  cadastros: <Boxes aria-hidden="true" />,
  automacoes: <Zap aria-hidden="true" />,
};

export function CockpitCards() {
  const { data } = useBlocoConfig(undefined, "card");
  const cfg = useMemo(() => makeScopeConfig("card", data ?? []), [data]);

  const ordered = useMemo(
    () =>
      COCKPIT_CARDS.map((card, idx) => ({
        card,
        ordem: cfg.ordemOf(card.escopo, idx),
        idx,
      })).sort((a, b) => a.ordem - b.ordem || a.idx - b.idx),
    [cfg],
  );

  return (
    <div className="grid-dlh g3 stat-rise">
      {ordered.map(({ card }, i) => (
        <ModuloCard
          key={card.escopo}
          index={i}
          icon={CARD_ICONS[card.iconKey]}
          title={card.title}
          description={card.description}
          href={card.href}
          hidden={!cfg.isOn(card.escopo)}
        />
      ))}
    </div>
  );
}
