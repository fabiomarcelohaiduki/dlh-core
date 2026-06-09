"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Loader2, RefreshCw, TriangleAlert, KeyRound, SlidersHorizontal } from "lucide-react";
import { useSalvarCredencial, useTestarConexao } from "@/hooks/use-admin";
import { ApiError } from "@/lib/api/client";
import { conexaoDescriptor } from "@/lib/status";
import { formatDateTime } from "@/lib/format";
import { SourceCardHeader } from "@/components/cockpit/source-card";
import type { EstadoConexao, FonteCredState, FonteTipo } from "@/lib/api/types";

type CredValues = { token: string };

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * Identidade visual/comportamental da fonte no cmp-cred-form. Default Effecti
 * (preserva o bloco existente sem alteracoes); o bloco Nomus passa o seu.
 */
export interface CredFormSource {
  /** Tipo da fonte para os hooks (effecti|nomus). */
  fonteTipo: FonteTipo;
  /** Iniciais do avatar do card (ex.: "Ef", "No"). */
  avatar: string;
  /** Subtitulo sob o nome da fonte. */
  subtitulo: string;
  /** Rotulo do campo "Tipo" no kv. */
  tipoLabel: string;
}

const EFFECTI_SOURCE: CredFormSource = {
  fonteTipo: "effecti",
  avatar: "Ef",
  subtitulo: "Conector via API · avisos de licitação",
  tipoLabel: "API REST",
};

/**
 * Copy especifica por causa de falha do teste (alinhada ao backend 4.5.1).
 * Espelha 1:1 a copy do bloco Effecti, parametrizada pelo nome da fonte.
 */
function messageForTest(err: unknown, nome: string): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return "Configure e salve a credencial antes de testar a conexão.";
    if (err.status === 401) return `Credencial ${nome} inválida ou expirada (401).`;
    if (err.status === 429)
      return `Limite de requisições do ${nome} atingido (429). Tente novamente em instantes.`;
    if (err.status === 408) return `Tempo de resposta excedido ao contatar o ${nome} (timeout).`;
  }
  return "Não foi possível testar a conexão. Tente novamente.";
}

/**
 * cmp-cred-form — Formulario de credencial da fonte (US-07/US-03).
 *
 * Parametrizado por fonte (default Effecti). Estados idle/loading/success/error.
 * Duas acoes INDEPENDENTES:
 *   - action-salvar-cred  (useSalvarCredencial -> PUT credencial)
 *   - action-testar-conexao (useTestarConexao -> POST testar)
 * O sucesso do salvar coexiste com a falha do teste (feedbacks separados).
 *
 * Seguranca (RNF-02): o token salvo nunca volta ao cliente. Quando ja ha
 * credencial (`configurado`), exibe o estado mascarado com a acao
 * 'Substituir'; cancelar a substituicao mantem o valor salvo. nao_configurada
 * (seed) liga-se ao idle/onboarding (input ja aberto).
 */
export function CredForm({
  fonte,
  source = EFFECTI_SOURCE,
  configAberto,
  onConfigurar,
  configPanelId = "painel-config-fonte",
}: {
  fonte: FonteCredState;
  /** Identidade da fonte (default Effecti). */
  source?: CredFormSource;
  /** Estado do painel de configuracao da fonte (controlado pelo wrapper). */
  configAberto?: boolean;
  /** Abre/fecha o painel de configuracao da fonte. Sem callback, o botao some. */
  onConfigurar?: () => void;
  /** Id do painel de configuracao controlado (aria-controls). */
  configPanelId?: string;
}) {
  const salvar = useSalvarCredencial(source.fonteTipo);
  const testar = useTestarConexao(source.fonteTipo);

  /**
   * Schema cliente do token (espelha o backend): token nao-vazio apos trim.
   * Mensagem parametrizada pelo nome da fonte; o submit vazio e bloqueado aqui
   * antes de chegar ao servidor (defesa em profundidade).
   */
  const credSchema = useMemo(
    () => z.object({ token: z.string().trim().min(1, `Informe o token ${fonte.nome}.`) }),
    [fonte.nome],
  );

  // Id unico por fonte: dois CredForms coexistem na tela de Fontes.
  const tokenFieldId = `cred-token-${source.fonteTipo}`;

  // `configurado` controla a UI mascarada vs. input aberto.
  const [configurado, setConfigurado] = useState(fonte.configurado);
  // Em nao_configurada (onboarding) o input ja nasce aberto (idle).
  const [editing, setEditing] = useState(!fonte.configurado);
  // Estado de conexao refletido no pill; o teste o atualiza em runtime.
  const [conexao, setConexao] = useState<EstadoConexao>(fonte.estadoConexao);

  const [saveFeedback, setSaveFeedback] = useState<Feedback | null>(null);
  const [testFeedback, setTestFeedback] = useState<Feedback | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors },
  } = useForm<CredValues>({
    resolver: zodResolver(credSchema),
    defaultValues: { token: "" },
  });

  const pill = conexaoDescriptor(conexao);

  async function onSubmit(values: CredValues) {
    setSaveFeedback(null);
    try {
      await salvar.mutateAsync(values.token);
      setConfigurado(true);
      setEditing(false);
      reset({ token: "" });
      setSaveFeedback({ kind: "ok", message: "Credencial salva · teste a conexão" });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 400
          ? `Token inválido: informe um token ${fonte.nome} não vazio.`
          : "Não foi possível salvar a credencial. Tente novamente.";
      setSaveFeedback({ kind: "err", message });
    }
  }

  async function handleTest() {
    setTestFeedback(null);
    try {
      const res = await testar.mutateAsync();
      setConexao(res.estadoConexao);
      if (res.estadoConexao === "conectada") {
        setTestFeedback({
          kind: "ok",
          // Nomus nao testa via Edge (TLS legado): a saude vem da coleta na
          // nuvem, entao mostramos a mensagem do backend em vez de latencia.
          message:
            source.fonteTipo === "nomus"
              ? res.mensagem ?? "Conexão validada pela última coleta na nuvem."
              : `Conexão OK · latência ${res.latenciaMs} ms`,
        });
      } else {
        setTestFeedback({
          kind: "err",
          message: res.mensagem ?? `Falha ao conectar ao ${fonte.nome}.`,
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConexao("nao_configurada");
      } else {
        setConexao("erro");
      }
      setTestFeedback({ kind: "err", message: messageForTest(err, fonte.nome) });
    }
  }

  function startReplace() {
    setEditing(true);
    setSaveFeedback(null);
    reset({ token: "" });
    setTimeout(() => setFocus("token"), 0);
  }

  function cancelReplace() {
    // Cancelar a substituicao mantem o valor salvo (volta ao mascarado).
    setEditing(false);
    reset({ token: "" });
  }

  const saving = salvar.isPending;
  const testing = testar.isPending;

  return (
    <div className="card">
      <SourceCardHeader
        avatar={source.avatar}
        nome={fonte.nome}
        subtitulo={source.subtitulo}
        pill={pill}
      />

      <dl className="kv">
        <dt>Tipo</dt>
        <dd>{source.tipoLabel}</dd>
        <dt>Endpoint base</dt>
        <dd className="mono">{fonte.endpointBase}</dd>
        <dt>Última verificação</dt>
        <dd className="tnum">{formatDateTime(fonte.ultimaVerificacao)}</dd>
        <dt>Token</dt>
        <dd className="mono">
          {configurado ? "•••••••••••••• (cifrado)" : "Não configurado"}
        </dd>
      </dl>

      <form onSubmit={handleSubmit(onSubmit)} style={{ marginTop: 20 }} noValidate>
        {editing ? (
          <div className={`field${errors.token ? " invalid" : ""}`}>
            <label htmlFor={tokenFieldId}>
              {configurado ? "Novo token de API" : `Token de API ${fonte.nome}`}
            </label>
            <div className="input-affix">
              <input
                type="password"
                id={tokenFieldId}
                placeholder={`Cole o token ${fonte.nome}`}
                autoComplete="off"
                aria-invalid={Boolean(errors.token)}
                {...register("token")}
              />
            </div>
            <div className="err-msg">
              <TriangleAlert aria-hidden="true" />
              {errors.token?.message}
            </div>
            <div className="helper">
              O token é armazenado cifrado no Supabase Vault e nunca exibido após salvo.
            </div>
          </div>
        ) : (
          <div className="field">
            <label>Token configurado</label>
            <div
              className="input-affix"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                height: 40,
                padding: "0 13px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--r-sm)",
                color: "var(--muted)",
              }}
            >
              <KeyRound aria-hidden="true" style={{ width: 15, height: 15, flex: "none" }} />
              <span className="mono" style={{ fontSize: 13 }}>
                •••••••••••••• cifrado no Vault
              </span>
            </div>
            <div className="helper">
              A credencial está salva. Use “Substituir token” para trocá-la.
            </div>
          </div>
        )}

        <div className="form-foot cred-actions">
          {editing ? (
            <>
              <button className="btn btn-primary" type="submit" disabled={saving}>
                {saving ? (
                  <Loader2 className="spin" aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                <span>{saving ? "Salvando…" : "Salvar credencial"}</span>
              </button>
              {configurado && (
                <button className="btn" type="button" onClick={cancelReplace} disabled={saving}>
                  Cancelar
                </button>
              )}
            </>
          ) : (
            <button className="btn" type="button" onClick={startReplace}>
              <KeyRound aria-hidden="true" />
              <span>Substituir token</span>
            </button>
          )}

          <button className="btn" type="button" onClick={handleTest} disabled={testing}>
            {testing ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            <span>{testing ? "Testando…" : "Testar conexão"}</span>
          </button>

          {onConfigurar && (
            <button
              className={`btn${configAberto ? " btn-primary" : ""}`}
              type="button"
              onClick={onConfigurar}
              aria-expanded={configAberto}
              aria-controls={configPanelId}
            >
              <SlidersHorizontal aria-hidden="true" />
              <span>Configurar</span>
            </button>
          )}
        </div>

        {(saveFeedback || testFeedback) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
            {saveFeedback && (
              <span className={`save-note${saveFeedback.kind === "err" ? " err" : ""}`}>
                {saveFeedback.kind === "err" ? (
                  <TriangleAlert aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                {saveFeedback.message}
              </span>
            )}
            {testFeedback && (
              <span className={`save-note${testFeedback.kind === "err" ? " err" : ""}`}>
                {testFeedback.kind === "err" ? (
                  <TriangleAlert aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                {testFeedback.message}
              </span>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
