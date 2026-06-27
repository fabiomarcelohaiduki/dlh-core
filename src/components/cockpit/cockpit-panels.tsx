"use client";

// =====================================================================
// cockpit-panels — painéis fixos do cockpit, governados por bloco_config.
//
// Lê o snapshot de `bloco_config` (tipo `widget`) e respeita a visibilidade
// definida em "Configuração do cockpit". Mantém o layout canônico de duas
// colunas (mapa-sinais à esquerda; saúde + atalhos à direita), omitindo os
// painéis ocultos. Sem config persistida, todos aparecem.
// =====================================================================

import { useMemo } from "react";
import { makeScopeConfig } from "@/lib/engines/block-vis";
import { useBlocoConfig } from "@/hooks/use-configuracao";
import { MapaSinais } from "@/components/cockpit/widgets/mapa-sinais";
import { SaudeCockpit } from "@/components/cockpit/widgets/saude-cockpit";
import { AtalhosOperacionais } from "@/components/cockpit/widgets/atalhos-operacionais";
import { WidgetErrorBoundary } from "@/components/cockpit/widgets/widget-error";

export function CockpitPanels() {
  const { data } = useBlocoConfig(undefined, "widget");
  const cfg = useMemo(() => makeScopeConfig("widget", data ?? []), [data]);

  const showMapa = cfg.isOn("mapa-sinais");
  const showSaude = cfg.isOn("saude-cockpit");
  const showAtalhos = cfg.isOn("atalhos-operacionais");

  if (!showMapa && !showSaude && !showAtalhos) return null;

  return (
    <WidgetErrorBoundary>
      <div className="cockpit-panels">
        {showMapa ? <MapaSinais /> : null}
        {showSaude || showAtalhos ? (
          <div className="cockpit-side">
            {showSaude ? <SaudeCockpit /> : null}
            {showAtalhos ? <AtalhosOperacionais /> : null}
          </div>
        ) : null}
      </div>
    </WidgetErrorBoundary>
  );
}
