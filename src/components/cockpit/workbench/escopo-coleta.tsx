"use client";

import { type ReactNode } from "react";
import { Factory, Gavel, HardDrive, Mail } from "lucide-react";
import { CfgAccordion } from "@/components/cockpit/config/cfg-accordion";
import { CfgForm } from "@/components/cockpit/cfg-form";
import { NomusCfgForm } from "@/components/cockpit/nomus-cfg-form";
import { DrivePastasForm } from "@/components/cockpit/drive-pastas-form";
import { GmailConfigForm } from "@/components/cockpit/gmail-config-form";
import type { EscopoColetaData } from "@/lib/fontes-credenciais-data";

/**
 * cmp-escopo-coleta — guia Escopo do submodulo Coleta.
 *
 * Reune o que DEFINE a coleta de cada fonte (Effecti, Nomus, Drive, Gmail): os
 * filtros (janela/modalidades/portais, recursos/tipos, pastas, data/categorias/
 * labels). Saiu das Integracoes, onde ficava misturado com as credenciais —
 * estas seguem la (token/OAuth/painel web). O disparo manual mora na guia
 * Execucoes. Cada card e um acordeon (um aberto por vez, padrao das
 * Configuracoes); o corpo instancia os mesmos forms que persistem cada filtro
 * no backend.
 */

const ICON_STYLE = { width: 17, height: 17 } as const;

/** Card de uma fonte no acordeon: cabecalho (avatar + nome + nota) + corpo. */
function EscopoCard({
  id,
  icon,
  nome,
  nota,
  children,
}: {
  id: string;
  icon: ReactNode;
  nome: string;
  nota: string;
  children: ReactNode;
}) {
  return (
    <section className="cfg-panel-card" aria-labelledby={`escopo-${id}-h`}>
      <div className="panel-header">
        <div
          className="panel-title"
          style={{ display: "flex", alignItems: "center", gap: 12 }}
        >
          <span
            className="avatar"
            style={{
              borderRadius: 9,
              width: 34,
              height: 34,
              color: "var(--accent)",
              background: "var(--accent-soft)",
              borderColor: "var(--accent-line)",
            }}
          >
            {icon}
          </span>
          <div>
            <h3 id={`escopo-${id}-h`}>{nome}</h3>
            <p>{nota}</p>
          </div>
        </div>
      </div>
      <div className="cfg-panel-body">{children}</div>
    </section>
  );
}

export function EscopoColeta({
  effectiId,
  effectiConfig,
  nomusId,
  drivePastas,
  gmailConfig,
  gmailLabels,
}: EscopoColetaData) {
  return (
    <CfgAccordion>
      <EscopoCard
        id="effecti"
        icon={<Gavel aria-hidden="true" style={ICON_STYLE} />}
        nome="Effecti"
        nota="Janela de avisos, modalidades e portais que entram na coleta. Os filtros valem na próxima execução."
      >
        <CfgForm initial={effectiConfig} fonteId={effectiId} />
      </EscopoCard>

      <EscopoCard
        id="nomus"
        icon={<Factory aria-hidden="true" style={ICON_STYLE} />}
        nome="Nomus"
        nota="Recursos e tipos coletados do ERP. O disparo manual fica na guia Execuções."
      >
        <NomusCfgForm fonteId={nomusId} disparo={false} />
      </EscopoCard>

      <EscopoCard
        id="drive"
        icon={<HardDrive aria-hidden="true" style={ICON_STYLE} />}
        nome="Google Drive"
        nota="Pastas varridas na descoberta de documentos. Adicione, pause ou remova as pastas cadastradas."
      >
        <DrivePastasForm initial={drivePastas} />
      </EscopoCard>

      <EscopoCard
        id="gmail"
        icon={<Mail aria-hidden="true" style={ICON_STYLE} />}
        nome="Gmail"
        nota="Data inicial, categorias e labels excluídas que filtram os e-mails coletados."
      >
        <GmailConfigForm config={gmailConfig} labels={gmailLabels} />
      </EscopoCard>
    </CfgAccordion>
  );
}
