"use client";

// =====================================================================
// dashboard-grid — renderCockpitWidgets: a grade `.dashboard-grid` (delta-17).
//
// Hospeda os painéis fixos do cockpit (Mapa de sinais à esquerda; Saúde e
// Atalhos na coluna lateral). A visibilidade de cada painel vem de bloco_config
// (tipo widget) e é aplicada por `data-cockpit-widget`. A grade colapsa:
//   - `.no-map`  quando o Mapa de sinais está oculto
//   - `.no-side` quando a coluna lateral inteira está vazia
// Tudo oculto -> a grade não renderiza (não deixa coluna fantasma).
// =====================================================================

import { useMemo } from "react";
import { makeScopeConfig } from "@/lib/engines/block-vis";
import { useBlocoConfig } from "@/hooks/use-configuracao";
import { MapaSinais } from "@/components/cockpit/widgets/mapa-sinais";
import { SaudeCockpit } from "@/components/cockpit/widgets/saude-cockpit";
import { AtalhosOperacionais } from "@/components/cockpit/widgets/atalhos-operacionais";
import { WidgetErrorBoundary } from "@/components/cockpit/widgets/widget-error";

export function DashboardGrid() {
  const { data } = useBlocoConfig(undefined, "widget");
  const cfg = useMemo(() => makeScopeConfig("widget", data ?? []), [data]);

  const showMapa = cfg.isOn("mapa-sinais");
  const showSaude = cfg.isOn("saude-cockpit");
  const showAtalhos = cfg.isOn("atalhos-operacionais");

  const noSide = !showSaude && !showAtalhos;
  const noMap = !showMapa;

  // Tudo oculto: nada a renderizar.
  if (noMap && noSide) return null;

  const className = ["dashboard-grid", noMap ? "no-map" : "", noSide ? "no-side" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <WidgetErrorBoundary>
      <div className={className} id="cockpitGrid">
        {showMapa ? <MapaSinais /> : null}
        {!noSide ? (
          <aside className="side-stack" id="cockpitSideStack">
            {showSaude ? <SaudeCockpit /> : null}
            {showAtalhos ? <AtalhosOperacionais /> : null}
          </aside>
        ) : null}
      </div>
    </WidgetErrorBoundary>
  );
}
