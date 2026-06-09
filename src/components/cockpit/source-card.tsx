"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Link2, Loader2, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/cockpit/status-pill";
import { formatDateTime } from "@/lib/format";
import type { PillState } from "@/lib/status";

type Pill = { state: PillState; label: string };

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * Cabecalho de uma secao do painel de configuracao (titulo + descricao no
 * padrao section-title>titles). Antecede o corpo `card form-card` de cada
 * bloco — padrao unico para Agendamento, Configuracao e fontes futuras.
 */
export function ConfigSectionHeading({
  title,
  description,
  style,
}: {
  title: string;
  description?: string;
  style?: CSSProperties;
}) {
  return (
    <div className="section-title" style={style}>
      <div className="titles">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
    </div>
  );
}

/**
 * Cabecalho padrao de todo card de fonte: avatar (iniciais ou icone) + nome +
 * pill de status. Fonte unica do layout do topo do card.
 */
export function SourceCardHeader({
  avatar,
  nome,
  pill,
}: {
  avatar: ReactNode;
  nome: string;
  pill: Pill;
}) {
  return (
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
        {avatar}
      </div>
      <b style={{ flex: 1, fontSize: 15 }}>{nome}</b>
      <StatusPill state={pill.state} label={pill.label} />
    </div>
  );
}

/**
 * Le ?<param>=conectado|erro do retorno do callback OAuth (uma vez no mount) e
 * limpa a query da URL para nao repetir o aviso ao recarregar. A Edge de OAuth
 * redireciona para ca apos o consentimento do Google.
 */
function useOAuthCallbackFeedback(
  param: string,
  okMessage: string,
  errMessage: string,
): Feedback | null {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const valor = params.get(param);
    if (valor !== "conectado" && valor !== "erro") return;
    setFeedback(
      valor === "conectado"
        ? { kind: "ok", message: okMessage }
        : { kind: "err", message: errMessage },
    );
    params.delete(param);
    const limpa = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (limpa ? `?${limpa}` : ""),
    );
  }, [param, okMessage, errMessage]);
  return feedback;
}

/** Conta Google conectada via OAuth (Drive e Gmail compartilham este formato). */
type OAuthConta = {
  conectado: boolean;
  email: string | null;
  conectadoEm: string | null;
};

/** Mutation de inicio do fluxo OAuth (useConectarDrive/useConectarGmail). */
type OAuthConectar = {
  mutateAsync: () => Promise<{ url: string }>;
  isPending: boolean;
};

/**
 * Card de uma fonte conectada via OAuth (Drive, Gmail e futuras). Concentra o
 * layout comum (header, conta, botoes Conectar/Configurar, ajuda e feedback do
 * callback); as linhas especificas do kv entram via `children` e o pill e o
 * texto de ajuda/configuracao chegam por prop.
 */
export function OAuthSourceCard({
  icon,
  nome,
  tipoLabel,
  pill,
  conta,
  conectar,
  callbackParam,
  callbackOk,
  callbackErr,
  ajudaDesconectada,
  configurarLabel,
  configAberto,
  onConfigurar,
  configPanelId,
  children,
}: {
  icon: ReactNode;
  nome: string;
  /** Valor da linha "Tipo" do kv (ex.: "Google Drive API"). */
  tipoLabel: string;
  pill: Pill;
  conta: OAuthConta;
  conectar: OAuthConectar;
  /** Chave da query do callback (?drive / ?gmail). */
  callbackParam: string;
  callbackOk: string;
  callbackErr: string;
  /** Ajuda exibida enquanto nenhuma conta esta conectada. */
  ajudaDesconectada: string;
  configurarLabel: string;
  configAberto: boolean;
  onConfigurar: () => void;
  configPanelId: string;
  /** Linhas dt/dd especificas da fonte, anexadas ao kv comum. */
  children: ReactNode;
}) {
  const callbackFeedback = useOAuthCallbackFeedback(callbackParam, callbackOk, callbackErr);
  const [erroIniciar, setErroIniciar] = useState<string | null>(null);

  async function handleConectar() {
    setErroIniciar(null);
    try {
      const { url } = await conectar.mutateAsync();
      // Redireciona o navegador inteiro ao consentimento; o callback volta
      // para esta pagina com ?<param>=conectado|erro.
      window.location.assign(url);
    } catch {
      setErroIniciar("Não foi possível iniciar a conexão. Tente novamente.");
    }
  }

  const conectando = conectar.isPending;
  const feedback = erroIniciar ? { kind: "err", message: erroIniciar } as const : callbackFeedback;

  return (
    <div className="card">
      <SourceCardHeader avatar={icon} nome={nome} pill={pill} />

      <dl className="kv">
        <dt>Tipo</dt>
        <dd>{tipoLabel}</dd>
        <dt>Conta conectada</dt>
        <dd className="mono">{conta.email ?? "Nenhuma"}</dd>
        <dt>Conectada em</dt>
        <dd className="tnum">{formatDateTime(conta.conectadoEm)}</dd>
        {children}
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
          <span>{configurarLabel}</span>
        </button>
      </div>

      {!conta.conectado && (
        <div className="helper" style={{ marginTop: 12 }}>
          {ajudaDesconectada}
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
