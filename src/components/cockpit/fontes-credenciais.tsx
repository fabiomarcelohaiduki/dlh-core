"use client";

import { useRef, useState, type ReactNode } from "react";
import { Factory, Gavel, HardDrive, Mail, X } from "lucide-react";
import { CredForm, type CredFormSource } from "@/components/cockpit/cred-form";
import { EffectiPainelCredForm } from "@/components/cockpit/effecti-painel-cred-form";
import { OAuthSourceCard } from "@/components/cockpit/source-card";
import { useConectarDrive } from "@/hooks/use-drive-oauth";
import { useConectarGmail } from "@/hooks/use-gmail-oauth";
import type {
  AgendamentoFonteState,
  DriveContaState,
  DrivePastaState,
  FonteCredState,
  FonteEffectiState,
  GmailConfigState,
  GmailContaState,
  GmailLabelState,
} from "@/lib/api/types";

/**
 * Cabecalho de identidade do painel de configuracao: avatar + nome da fonte +
 * acao de fechar. Resolve a ambiguidade de "qual card abriu" quando o painel
 * abre abaixo da grade 2-up. `subtitle` adapta a copy por fonte (coleta vs.
 * apenas extracao).
 */
function ConfigPanelHeader({
  avatar,
  nome,
  onClose,
  subtitle = "Parâmetros aplicados na próxima coleta desta fonte.",
}: {
  avatar: ReactNode;
  nome: string;
  onClose: () => void;
  subtitle?: string;
}) {
  return (
    <div className="cfg-panel-head">
      <div
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
        {avatar}
      </div>
      <div style={{ flex: 1 }}>
        <b style={{ fontSize: 14.5 }}>{nome}</b>
        <div style={{ color: "var(--muted)", fontSize: 12 }}>{subtitle}</div>
      </div>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        <X aria-hidden="true" />
        <span>Fechar</span>
      </button>
    </div>
  );
}

/** Identidade da fonte Nomus no CredForm (parametrizado por fonte). */
const NOMUS_SOURCE: CredFormSource = {
  fonteTipo: "nomus",
  avatar: <Factory aria-hidden="true" style={{ width: 18, height: 18 }} />,
  tipoLabel: "API REST",
};

/**
 * So o Effecti tem painel proprio aqui: a credencial do painel web (login do
 * site, separada do token de API). As demais fontes nao abrem painel — seus
 * filtros migraram para a guia Escopo da Coleta.
 */
type PainelFonte = "effecti" | null;

const EFFECTI_PANEL = "painel-credencial-effecti";

/**
 * Card da fonte Drive: conta Google conectada pelo cockpit (Edge drive-oauth) e
 * pastas administraveis. Pill reflete o agendamento (Drive ganhou coleta propria
 * agendavel, igual Gmail): "Ativa" so quando conectada + agendamento ligado +
 * ha pastas ativas; "Pausada" quando conectada mas sem agendamento/pastas.
 */
function DriveCard({
  pastas,
  conta,
  agendamento,
}: {
  pastas: DrivePastaState[];
  conta: DriveContaState;
  agendamento: AgendamentoFonteState;
}) {
  const conectar = useConectarDrive();
  const ativas = pastas.filter((p) => p.ativo).length;
  const pill = !conta.conectado
    ? ({ state: "idle", label: "Desconectada" } as const)
    : agendamento.ativo && ativas > 0
      ? ({ state: "ok", label: "Ativa" } as const)
      : pastas.length > 0
        ? ({ state: "idle", label: "Pausada" } as const)
        : ({ state: "idle", label: "Sem pastas" } as const);

  return (
    <OAuthSourceCard
      icon={<HardDrive aria-hidden="true" style={{ width: 18, height: 18 }} />}
      nome="Google Drive"
      tipoLabel="Google Drive API"
      pill={pill}
      conta={conta}
      conectar={conectar}
      callbackParam="drive"
      callbackOk="Conta do Google conectada · pronto para varrer as pastas."
      callbackErr="Não foi possível conectar a conta do Google. Tente novamente."
      ajudaDesconectada="Conecte uma conta Google para varrer as pastas. Trocar de conta limpa as pastas cadastradas."
    >
      <dt>Pastas cadastradas</dt>
      <dd className="tnum">{pastas.length}</dd>
      <dt>Pastas ativas</dt>
      <dd className="tnum">{ativas}</dd>
    </OAuthSourceCard>
  );
}

/**
 * Card da fonte Gmail: conta Google conectada pelo cockpit (Edge gmail-oauth),
 * INDEPENDENTE do Drive (refresh_token proprio no Vault). Pill reflete o
 * agendamento (Gmail coleta corpo + anexos dos e-mails).
 */
function GmailCard({
  conta,
  config,
  labels,
  agendamento,
}: {
  conta: GmailContaState;
  config: GmailConfigState;
  labels: GmailLabelState[];
  agendamento: AgendamentoFonteState;
}) {
  const conectar = useConectarGmail();
  const excluidas = labels.filter((l) => l.ativo).length;
  const pill = !conta.conectado
    ? ({ state: "idle", label: "Desconectada" } as const)
    : agendamento.ativo
      ? ({ state: "ok", label: "Ativa" } as const)
      : ({ state: "idle", label: "Pausada" } as const);

  return (
    <OAuthSourceCard
      icon={<Mail aria-hidden="true" style={{ width: 18, height: 18 }} />}
      nome="Gmail"
      tipoLabel="Gmail API"
      pill={pill}
      conta={conta}
      conectar={conectar}
      callbackParam="gmail"
      callbackOk="Conta do Gmail conectada · pronto para coletar os e-mails."
      callbackErr="Não foi possível conectar a conta do Gmail. Tente novamente."
      ajudaDesconectada="Conecte uma conta Google para coletar os e-mails. Trocar de conta limpa as labels cadastradas."
    >
      <dt>Coletar a partir de</dt>
      <dd className="tnum">{config.dataInicial ?? "—"}</dd>
      <dt>Labels excluídas</dt>
      <dd className="tnum">{excluidas}</dd>
    </OAuthSourceCard>
  );
}

/**
 * Linha de fontes em grade 2-up responsiva (`grid-dlh g2`, colapsa para 1
 * coluna < 920px). Cada card revela seu painel de configuracao em largura
 * contida ABAIXO da linha, com rolagem suave ate o painel. Concentra o estado
 * de abertura dos cards para que a grade fique alinhada e os paineis nao
 * distorcam as colunas.
 */
export function FontesCredenciais({
  effecti,
  gmailAgendamento,
  driveAgendamento,
  nomus,
  drivePastas,
  driveConta,
  gmailConta,
  gmailConfig,
  gmailLabels,
}: {
  effecti: FonteEffectiState;
  gmailAgendamento: AgendamentoFonteState;
  driveAgendamento: AgendamentoFonteState;
  nomus: FonteCredState;
  drivePastas: DrivePastaState[];
  driveConta: DriveContaState;
  gmailConta: GmailContaState;
  gmailConfig: GmailConfigState;
  gmailLabels: GmailLabelState[];
}) {
  // Accordion: o painel de credencial do Effecti abre/fecha abaixo da grade.
  const [aberto, setAberto] = useState<PainelFonte>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  function toggle(painel: NonNullable<PainelFonte>) {
    setAberto((atual) => {
      if (atual === painel) {
        // fechar: volta a rolagem para a grade de cards
        setTimeout(() => {
          gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 0);
        return null;
      }
      // abrir (ou trocar): aguarda a montagem do painel antes de rolar ate ele
      setTimeout(() => {
        panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
      return painel;
    });
  }

  return (
    <>
      <div ref={gridRef} className="grid-dlh g2" style={{ gap: 24 }}>
        <CredForm
          fonte={effecti}
          configAberto={aberto === "effecti"}
          onConfigurar={() => toggle("effecti")}
          configPanelId={EFFECTI_PANEL}
        />
        <CredForm fonte={nomus} source={NOMUS_SOURCE} />
        <DriveCard
          pastas={drivePastas}
          conta={driveConta}
          agendamento={driveAgendamento}
        />
        <GmailCard
          conta={gmailConta}
          config={gmailConfig}
          labels={gmailLabels}
          agendamento={gmailAgendamento}
        />
      </div>

      {aberto === "effecti" && (
        <div id={EFFECTI_PANEL} className="form-card cfg-panel" ref={panelRef}>
          <ConfigPanelHeader
            avatar={<Gavel aria-hidden="true" style={{ width: 17, height: 17 }} />}
            nome="Effecti"
            subtitle="Credencial do painel web (login do site), separada do token de API."
            onClose={() => toggle("effecti")}
          />
          <EffectiPainelCredForm configurado={effecti.painelConfigurado} />
        </div>
      )}
    </>
  );
}
