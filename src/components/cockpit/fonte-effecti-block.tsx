"use client";

import { useRef, useState } from "react";
import { CredForm } from "@/components/cockpit/cred-form";
import { CfgForm } from "@/components/cockpit/cfg-form";
import type { ConfigIngestaoState, FonteEffectiState } from "@/lib/api/types";

/**
 * cmp-fonte-effecti-block — compoe a credencial Effecti com o painel de
 * configuracao da MESMA fonte. A config nasce fechada e e revelada pelo botao
 * "Configurar" do card de credencial (estado compartilhado aqui). Ao abrir,
 * rola suavemente ate o painel.
 */
export function FonteEffectiBlock({
  fonte,
  config,
}: {
  fonte: FonteEffectiState;
  config: ConfigIngestaoState;
}) {
  const [aberto, setAberto] = useState(false);
  const painelRef = useRef<HTMLDivElement | null>(null);

  function toggle() {
    setAberto((v) => {
      const next = !v;
      if (next) {
        // aguarda a montagem do painel antes de rolar ate ele
        setTimeout(() => {
          painelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 0);
      }
      return next;
    });
  }

  return (
    <>
      <div className="grid-dlh g2">
        <CredForm fonte={fonte} configAberto={aberto} onConfigurar={toggle} />

        <div className="card" style={{ background: "var(--surface)", borderStyle: "dashed" }}>
          <div className="section-title" style={{ margin: "0 0 14px" }}>
            <h3>Fontes futuras</h3>
            <span className="count">Fase 2</span>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 16px" }}>
            O substrato é multi-fonte por desenho. Estas fontes entram em fases seguintes.
          </p>
          <div className="grid-dlh" style={{ gap: 9 }}>
            <div className="chk disabled">
              <div className="t">
                E-mail operacional
                <small>Caixa de avisos por mensagem</small>
              </div>
            </div>
            <div className="chk disabled">
              <div className="t">
                ERP Nomus
                <small>Dados internos de operação</small>
              </div>
            </div>
            <div className="chk disabled">
              <div className="t">
                Google Drive
                <small>Documentos e planilhas</small>
              </div>
            </div>
          </div>
        </div>
      </div>

      {aberto && (
        <div id="painel-config-fonte" ref={painelRef}>
          <CfgForm initial={config} />
        </div>
      )}
    </>
  );
}
