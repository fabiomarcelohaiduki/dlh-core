"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, HardDrive, Link2, Loader2, SlidersHorizontal, TriangleAlert, X } from "lucide-react";
import { CredForm, type CredFormSource } from "@/components/cockpit/cred-form";
import { CfgForm } from "@/components/cockpit/cfg-form";
import { NomusCfgForm } from "@/components/cockpit/nomus-cfg-form";
import { DrivePastasForm } from "@/components/cockpit/drive-pastas-form";
import { StatusPill } from "@/components/cockpit/status-pill";
import { useConectarDrive } from "@/hooks/use-drive-oauth";
import { formatDateTime } from "@/lib/format";
import type {
  ConfigIngestaoState,
  DriveContaState,
  DrivePastaState,
  FonteCredState,
  FonteEffectiState,
} from "@/lib/api/types";

/**
 * Cabecalho de identidade do painel de configuracao: avatar + nome da fonte +
 * acao de fechar. Resolve a ambiguidade de "qual card abriu" quando o painel
 * abre abaixo da grade 2-up.
 */
function ConfigPanelHeader({
  avatar,
  nome,
  onClose,
}: {
  avatar: string;
  nome: string;
  onClose: () => void;
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
        <div style={{ color: "var(--muted)", fontSize: 12 }}>
          Parâmetros aplicados na próxima coleta desta fonte.
        </div>
      </div>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        <X aria-hidden="true" />
        <span>Fechar</span>
      </button>
    </div>
  );
}

/** Identidade da fonte Nomus no cmp-cred-form (parametrizado por fonte). */
const NOMUS_SOURCE: CredFormSource = {
  fonteTipo: "nomus",
  avatar: "No",
  subtitulo: "ERP Nomus · processos e operação interna",
  tipoLabel: "API REST",
};

const EFFECTI_PANEL = "painel-config-fonte";
const NOMUS_PANEL = "painel-config-fonte-nomus";
const DRIVE_PANEL = "painel-config-fonte-drive";

/**
 * Le ?drive=conectado|erro do retorno do callback OAuth (uma unica vez no
 * mount) e limpa a query da URL para nao repetir o aviso ao recarregar. O
 * callback da Edge redireciona para ca apos o consentimento do Google.
 */
function useDriveCallbackFeedback(): { kind: "ok" | "err"; message: string } | null {
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; message: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const drive = params.get("drive");
    if (drive !== "conectado" && drive !== "erro") return;
    setFeedback(
      drive === "conectado"
        ? { kind: "ok", message: "Conta do Google conectada · pronto para varrer as pastas." }
        : { kind: "err", message: "Não foi possível conectar a conta do Google. Tente novamente." },
    );
    params.delete("drive");
    const limpa = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (limpa ? `?${limpa}` : ""),
    );
  }, []);
  return feedback;
}

/**
 * cmp-drive-card — Card de identidade da fonte Drive na mesma grade de Effecti
 * e Nomus. A conta Google e conectada pelo proprio cockpit (botao "Conectar
 * Google"): o fluxo OAuth volta na Edge drive-oauth, que grava o refresh_token
 * cifrado no Vault e registra a conta. Trocar de conta limpa as pastas. O card
 * mostra a conta conectada e o botao 'Configurar pastas' revela o painel abaixo.
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
  const callbackFeedback = useDriveCallbackFeedback();
  const [erroIniciar, setErroIniciar] = useState<string | null>(null);

  const ativas = pastas.filter((p) => p.ativo).length;
  const pill = !conta.conectado
    ? ({ state: "idle", label: "Desconectada" } as const)
    : ativas > 0
      ? ({ state: "ok", label: "Ativa" } as const)
      : pastas.length > 0
        ? ({ state: "idle", label: "Pausada" } as const)
        : ({ state: "idle", label: "Sem pastas" } as const);

  async function handleConectar() {
    setErroIniciar(null);
    try {
      const { url } = await conectar.mutateAsync();
      // Redireciona o navegador inteiro ao consentimento do Google; o callback
      // volta para esta pagina com ?drive=conectado|erro.
      window.location.assign(url);
    } catch {
      setErroIniciar("Não foi possível iniciar a conexão. Tente novamente.");
    }
  }

  const conectando = conectar.isPending;
  const feedback = erroIniciar
    ? ({ kind: "err", message: erroIniciar } as const)
    : callbackFeedback;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <div
          className="avatar"
          style={{
            borderRadius: 9,
            width: 38,
            height: 38,
            color: "var(--accent)",
            background: "var(--accent-soft)",
            borderColor: "var(--accent-line)",
          }}
        >
          <HardDrive aria-hidden="true" style={{ width: 18, height: 18 }} />
        </div>
        <div style={{ flex: 1 }}>
          <b style={{ fontSize: 15 }}>Google Drive</b>
          <div style={{ color: "var(--muted)", fontSize: 12.5 }}>
            Conector via OAuth · documentos e editais
          </div>
        </div>
        <StatusPill state={pill.state} label={pill.label} />
      </div>

      <dl className="kv">
        <dt>Tipo</dt>
        <dd>Google Drive API</dd>
        <dt>Conta conectada</dt>
        <dd className="mono">{conta.email ?? "Nenhuma"}</dd>
        <dt>Conectada em</dt>
        <dd className="tnum">{formatDateTime(conta.conectadoEm)}</dd>
        <dt>Pastas cadastradas</dt>
        <dd className="tnum">{pastas.length}</dd>
        <dt>Pastas ativas</dt>
        <dd className="tnum">{ativas}</dd>
      </dl>

      <div className="form-foot cred-actions" style={{ marginTop: 20 }}>
        <button
          className={`btn${conta.conectado ? "" : " btn-primary"}`}
          type="button"
          onClick={handleConectar}
          disabled={conectando}
        >
          {conectando ? (
            <Loader2 className="spin" aria-hidden="true" />
          ) : (
            <Link2 aria-hidden="true" />
          )}
          <span>
            {conectando
              ? "Abrindo o Google…"
              : conta.conectado
                ? "Reconectar / trocar conta"
                : "Conectar Google"}
          </span>
        </button>

        <button
          className={`btn${configAberto ? " btn-primary" : ""}`}
          type="button"
          onClick={onConfigurar}
          aria-expanded={configAberto}
          aria-controls={configPanelId}
        >
          <SlidersHorizontal aria-hidden="true" />
          <span>Configurar pastas</span>
        </button>
      </div>

      {!conta.conectado && (
        <div className="helper" style={{ marginTop: 12 }}>
          Conecte uma conta Google para varrer as pastas. Trocar de conta limpa as pastas cadastradas.
        </div>
      )}

      {feedback && (
        <span className={`save-note${feedback.kind === "err" ? " err" : ""}`} style={{ marginTop: 14 }}>
          {feedback.kind === "err" ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          {feedback.message}
        </span>
      )}
    </div>
  );
}

/**
 * cmp-fontes-credenciais — Linha de fontes (Effecti + Nomus) em grade 2-up
 * responsiva (`grid-dlh g2`, colapsa para 1 coluna < 920px). Cada credencial
 * revela seu painel de configuracao em largura contida ABAIXO da linha, com
 * rolagem suave ate o painel. Concentra o estado dos dois cards para que a
 * grade fique alinhada e os paineis nao distorcam as colunas.
 */
export function FontesCredenciais({
  effecti,
  effectiConfig,
  nomus,
  drivePastas,
  driveConta,
}: {
  effecti: FonteEffectiState;
  effectiConfig: ConfigIngestaoState;
  nomus: FonteCredState;
  drivePastas: DrivePastaState[];
  driveConta: DriveContaState;
}) {
  const [effectiAberto, setEffectiAberto] = useState(false);
  const [nomusAberto, setNomusAberto] = useState(false);
  const [driveAberto, setDriveAberto] = useState(false);
  const effectiRef = useRef<HTMLDivElement | null>(null);
  const nomusRef = useRef<HTMLDivElement | null>(null);
  const driveRef = useRef<HTMLDivElement | null>(null);

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
      </div>

      {effectiAberto && (
        <div id={EFFECTI_PANEL} className="form-card cfg-panel" ref={effectiRef}>
          <ConfigPanelHeader
            avatar="Ef"
            nome="Effecti"
            onClose={() => toggle(setEffectiAberto, effectiRef)}
          />
          <CfgForm initial={effectiConfig} />
        </div>
      )}

      {nomusAberto && (
        <div id={NOMUS_PANEL} className="form-card cfg-panel" ref={nomusRef}>
          <ConfigPanelHeader
            avatar="No"
            nome="Nomus"
            onClose={() => toggle(setNomusAberto, nomusRef)}
          />
          <NomusCfgForm />
        </div>
      )}

      {driveAberto && (
        <div id={DRIVE_PANEL} className="form-card cfg-panel" ref={driveRef}>
          <ConfigPanelHeader
            avatar="Dr"
            nome="Google Drive"
            onClose={() => toggle(setDriveAberto, driveRef)}
          />
          <DrivePastasForm initial={drivePastas} />
        </div>
      )}
    </>
  );
}
