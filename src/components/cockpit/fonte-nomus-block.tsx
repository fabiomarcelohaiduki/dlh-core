"use client";

import { useRef, useState } from "react";
import { CredForm, type CredFormSource } from "@/components/cockpit/cred-form";
import { NomusCfgForm } from "@/components/cockpit/nomus-cfg-form";
import { NomusColetaButton } from "@/components/cockpit/nomus-coleta-button";
import { FonteSaude } from "@/components/cockpit/fonte-saude";
import { useFontes } from "@/hooks/use-fontes";
import type { FonteCredState } from "@/lib/api/types";

/** Identidade da fonte Nomus no cmp-cred-form (parametrizado por fonte). */
const NOMUS_SOURCE: CredFormSource = {
  fonteTipo: "nomus",
  avatar: "No",
  subtitulo: "ERP Nomus · processos e operação interna",
  tipoLabel: "API REST",
};

const PANEL_ID = "painel-config-fonte-nomus";
const BLOCKED_REASON = "Cadastre e salve a chave antes de coletar.";

/**
 * cmp-fonte-nomus-block — compoe a credencial Nomus (CredForm parametrizado)
 * com a saude da fonte (estado_conexao + ultima_coleta), a coleta manual e o
 * painel de configuracao (recursos/tipos/janela). Espelha o bloco Effecti: a
 * config nasce fechada e e revelada pelo botao "Configurar" do card de
 * credencial; ao abrir, rola suavemente ate o painel. Respeita o Design Lock
 * (nenhuma tela/menu novo): entra na pagina /fontes existente.
 */
export function FonteNomusBlock({ fonte }: { fonte: FonteCredState }) {
  const [aberto, setAberto] = useState(false);
  const painelRef = useRef<HTMLDivElement | null>(null);

  const { data } = useFontes();
  const nomus = data?.find((f) => f.tipo === "nomus");
  const naoConfigurada = (nomus?.estadoConexao ?? fonte.estadoConexao) === "nao_configurada";

  function toggle() {
    setAberto((v) => {
      const next = !v;
      if (next) {
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
        <CredForm
          fonte={fonte}
          source={NOMUS_SOURCE}
          configAberto={aberto}
          onConfigurar={toggle}
          configPanelId={PANEL_ID}
        />

        <div className="card">
          <div className="section-title" style={{ margin: "0 0 14px" }}>
            <h3>Saúde da fonte</h3>
            <span className="count">Nomus</span>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "0 0 16px" }}>
            Estado da conexão e última coleta desta fonte. Dispare uma coleta manual para
            ingerir os registros mais recentes.
          </p>
          <FonteSaude tipo="nomus" />
          <div className="form-foot" style={{ marginTop: 18 }}>
            <NomusColetaButton blocked={naoConfigurada} blockedReason={BLOCKED_REASON} />
          </div>
        </div>
      </div>

      {aberto && (
        <div id={PANEL_ID} ref={painelRef}>
          <NomusCfgForm />
        </div>
      )}
    </>
  );
}
