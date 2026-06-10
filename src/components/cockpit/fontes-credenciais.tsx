"use client";

import { useRef, useState, type RefObject } from "react";
import { HardDrive, Mail, X } from "lucide-react";
import { CredForm, type CredFormSource } from "@/components/cockpit/cred-form";
import { CfgForm } from "@/components/cockpit/cfg-form";
import { EffectiDisparoForm } from "@/components/cockpit/effecti-disparo-form";
import { AgendamentoFonteForm } from "@/components/cockpit/agendamento-fonte-form";
import { NomusCfgForm } from "@/components/cockpit/nomus-cfg-form";
import { DrivePastasForm } from "@/components/cockpit/drive-pastas-form";
import { GmailConfigForm } from "@/components/cockpit/gmail-config-form";
import { GmailDisparoForm } from "@/components/cockpit/gmail-disparo-form";
import { OAuthSourceCard } from "@/components/cockpit/source-card";
import { useConectarDrive } from "@/hooks/use-drive-oauth";
import { useConectarGmail } from "@/hooks/use-gmail-oauth";
import type {
  AgendamentoFonteState,
  ConfigIngestaoState,
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
  avatar: string;
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
  avatar: "No",
  tipoLabel: "API REST",
};

const EFFECTI_PANEL = "painel-config-fonte";
const NOMUS_PANEL = "painel-config-fonte-nomus";
const DRIVE_PANEL = "painel-config-fonte-drive";
const GMAIL_PANEL = "painel-config-fonte-gmail";

/**
 * Card da fonte Drive: conta Google conectada pelo cockpit (Edge drive-oauth) e
 * pastas administraveis. Pill reflete pastas ativas (Drive so extrai, nao tem
 * agendamento de coleta).
 */
function DriveCard({
  pastas,
  conta,
  configAberto,
  onConfigurar,
  configPanelId,
}: {
  pastas: DrivePastaState[];
  conta: DriveContaState;
  configAberto: boolean;
  onConfigurar: () => void;
  configPanelId: string;
}) {
  const conectar = useConectarDrive();
  const ativas = pastas.filter((p) => p.ativo).length;
  const pill = !conta.conectado
    ? ({ state: "idle", label: "Desconectada" } as const)
    : ativas > 0
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
      configurarLabel="Configurar pastas"
      configAberto={configAberto}
      onConfigurar={onConfigurar}
      configPanelId={configPanelId}
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
  configAberto,
  onConfigurar,
  configPanelId,
}: {
  conta: GmailContaState;
  config: GmailConfigState;
  labels: GmailLabelState[];
  agendamento: AgendamentoFonteState;
  configAberto: boolean;
  onConfigurar: () => void;
  configPanelId: string;
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
      configurarLabel="Configurar coleta"
      configAberto={configAberto}
      onConfigurar={onConfigurar}
      configPanelId={configPanelId}
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
  effectiConfig,
  effectiAgendamento,
  nomusAgendamento,
  gmailAgendamento,
  nomus,
  drivePastas,
  driveConta,
  gmailConta,
  gmailConfig,
  gmailLabels,
}: {
  effecti: FonteEffectiState;
  effectiConfig: ConfigIngestaoState;
  effectiAgendamento: AgendamentoFonteState;
  nomusAgendamento: AgendamentoFonteState;
  gmailAgendamento: AgendamentoFonteState;
  nomus: FonteCredState;
  drivePastas: DrivePastaState[];
  driveConta: DriveContaState;
  gmailConta: GmailContaState;
  gmailConfig: GmailConfigState;
  gmailLabels: GmailLabelState[];
}) {
  const [effectiAberto, setEffectiAberto] = useState(false);
  const [nomusAberto, setNomusAberto] = useState(false);
  // Estado "alteracoes nao salvas" do CfgForm, subido para o bloco de coleta
  // manual do Effecti avisar antes de disparar com config pendente.
  const [effectiCfgDirty, setEffectiCfgDirty] = useState(false);
  const [driveAberto, setDriveAberto] = useState(false);
  const [gmailAberto, setGmailAberto] = useState(false);
  const effectiRef = useRef<HTMLDivElement | null>(null);
  const nomusRef = useRef<HTMLDivElement | null>(null);
  const driveRef = useRef<HTMLDivElement | null>(null);
  const gmailRef = useRef<HTMLDivElement | null>(null);

  function toggle(
    setter: React.Dispatch<React.SetStateAction<boolean>>,
    ref: RefObject<HTMLDivElement | null>,
  ) {
    setter((v) => {
      const next = !v;
      if (next) {
        // aguarda a montagem do painel antes de rolar ate ele
        setTimeout(() => {
          ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 0);
      }
      return next;
    });
  }

  return (
    <>
      <div className="grid-dlh g2" style={{ gap: 24, marginTop: 24 }}>
        <CredForm
          fonte={effecti}
          configAberto={effectiAberto}
          onConfigurar={() => toggle(setEffectiAberto, effectiRef)}
          configPanelId={EFFECTI_PANEL}
        />
        <CredForm
          fonte={nomus}
          source={NOMUS_SOURCE}
          configAberto={nomusAberto}
          onConfigurar={() => toggle(setNomusAberto, nomusRef)}
          configPanelId={NOMUS_PANEL}
        />
        <DriveCard
          pastas={drivePastas}
          conta={driveConta}
          configAberto={driveAberto}
          onConfigurar={() => toggle(setDriveAberto, driveRef)}
          configPanelId={DRIVE_PANEL}
        />
        <GmailCard
          conta={gmailConta}
          config={gmailConfig}
          labels={gmailLabels}
          agendamento={gmailAgendamento}
          configAberto={gmailAberto}
          onConfigurar={() => toggle(setGmailAberto, gmailRef)}
          configPanelId={GMAIL_PANEL}
        />
      </div>

      {effectiAberto && (
        <div id={EFFECTI_PANEL} className="form-card cfg-panel" ref={effectiRef}>
          <ConfigPanelHeader
            avatar="Ef"
            nome="Effecti"
            onClose={() => toggle(setEffectiAberto, effectiRef)}
          />
          <AgendamentoFonteForm initial={effectiAgendamento} />
          <EffectiDisparoForm fonteId={effecti.id} configDirty={effectiCfgDirty} />
          <CfgForm
            initial={effectiConfig}
            fonteId={effecti.id}
            onDirtyChange={setEffectiCfgDirty}
          />
        </div>
      )}

      {nomusAberto && (
        <div id={NOMUS_PANEL} className="form-card cfg-panel" ref={nomusRef}>
          <ConfigPanelHeader
            avatar="No"
            nome="Nomus"
            onClose={() => toggle(setNomusAberto, nomusRef)}
          />
          <NomusCfgForm agendamento={nomusAgendamento} fonteId={nomus.id} />
        </div>
      )}

      {driveAberto && (
        <div id={DRIVE_PANEL} className="form-card cfg-panel" ref={driveRef}>
          <ConfigPanelHeader
            avatar="Dr"
            nome="Google Drive"
            subtitle="Pastas administradas para extração de documentos."
            onClose={() => toggle(setDriveAberto, driveRef)}
          />
          <DrivePastasForm initial={drivePastas} />
        </div>
      )}

      {gmailAberto && (
        <div id={GMAIL_PANEL} className="form-card cfg-panel" ref={gmailRef}>
          <ConfigPanelHeader
            avatar="Gm"
            nome="Gmail"
            onClose={() => toggle(setGmailAberto, gmailRef)}
          />
          <AgendamentoFonteForm initial={gmailAgendamento} />
          <GmailDisparoForm />
          <GmailConfigForm config={gmailConfig} labels={gmailLabels} />
        </div>
      )}
    </>
  );
}
