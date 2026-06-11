"use client";

import { type CSSProperties, useState } from "react";
import {
  Check,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  Play,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useDescobrir, useExtracaoResumo } from "@/hooks/use-documentos";
import { useDispararDrive, useDispararExtracao, useDispararGmail } from "@/hooks/use-admin";
import { StatCard } from "@/components/cockpit/stat-card";
import {
  OrigemFiltro,
  type OrigemFiltroValue,
} from "@/components/cockpit/origem-filtro";
import type { FonteDescoberta } from "@/lib/api/documentos";
import { ApiError } from "@/lib/api/client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

type Feedback = { kind: "ok" | "err"; message: string };

/**
 * As 4 fontes do painel, com o modo de acao de cada uma:
 *  - 'descobrir' (Nomus/Effecti): descoberta SQL direta no Edge — enfileira e
 *    devolve a contagem na hora.
 *  - 'disparo' (Gmail/Drive): a lista de arquivos vive na API do Google, so o
 *    runner consegue descobrir. O botao dispara o workflow de coleta proprio da
 *    fonte (coletar-gmail.yml / coletar-drive.yml), assincrono na nuvem.
 */
type FontePainel = "nomus" | "effecti" | "gmail" | "drive";
type ModoAcao = "descobrir" | "disparo";

const FONTES: { value: FontePainel; label: string; modo: ModoAcao }[] = [
  { value: "nomus", label: "Nomus", modo: "descobrir" },
  { value: "effecti", label: "Effecti", modo: "descobrir" },
  { value: "gmail", label: "Gmail", modo: "disparo" },
  { value: "drive", label: "Drive", modo: "disparo" },
];

const FONTE_LABEL: Record<FontePainel, string> = {
  nomus: "Nomus",
  effecti: "Effecti",
  gmail: "Gmail",
  drive: "Drive",
};

/**
 * cmp-extracao-panel — Camada 1 do pipeline de documentos (multi-fonte).
 *
 * Reune as duas operacoes que o Fabio pediu no cockpit:
 *  1. DESCOBRIR: enfileira os anexos pendentes da fonte escolhida
 *     (POST documentos-descobrir). Idempotente — rodar de novo so pega
 *     anexos ineditos. Nomus e Effecti caem na MESMA fila (adaptador por fonte).
 *  2. VISIBILIDADE: contagens por status + tabela dos anexos que FALHARAM
 *     (qual arquivo, qual extensao, por que). Dados via Edge (service_role),
 *     GLOBAIS (somam todas as fontes).
 *
 * A descoberta Nomus exige a credencial Nomus salva; a Effecti le os avisos
 * ja presentes no banco e nao tem esse gate.
 */
export function ExtracaoPanel({
  nomusConfigurado = false,
}: {
  nomusConfigurado?: boolean;
}) {
  const resumo = useExtracaoResumo();
  const descobrir = useDescobrir();
  const dispararGmail = useDispararGmail();
  const dispararDrive = useDispararDrive();
  const dispararExtracao = useDispararExtracao();
  const [fonte, setFonte] = useState<FontePainel>("nomus");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Filtro de origem da tabela de erros (client-side, sobre a lista carregada).
  const [filtroFonte, setFiltroFonte] = useState<OrigemFiltroValue>("todas");

  const modo: ModoAcao = FONTES.find((f) => f.value === fonte)?.modo ?? "descobrir";
  // Acao por fonte (descobrir/coletar): NAO inclui o drain da fila (botao proprio).
  const pending = descobrir.isPending || dispararGmail.isPending || dispararDrive.isPending;
  // So Nomus depende de credencial; as demais nao tem esse gate aqui.
  const blocked = fonte === "nomus" && !nomusConfigurado;
  const blockedReason =
    "Cadastre e salve a chave do Nomus (em Fontes e credenciais) antes de descobrir anexos.";
  const disabled = blocked || pending;
  const contagens = resumo.data?.contagens;
  const erros = resumo.data?.erros ?? [];
  const errosFiltrados =
    filtroFonte === "todas" ? erros : erros.filter((e) => e.fonte === filtroFonte);

  const actionLabel =
    modo === "descobrir"
      ? `Descobrir anexos pendentes · ${FONTE_LABEL[fonte]}`
      : fonte === "gmail"
        ? "Coletar Gmail agora"
        : "Coletar Drive agora";

  // Legenda fraca sob cada botao (mesmo padrao dos cards de Fontes). A do botao
  // principal muda por fonte: descobrir enfileira anexos ja no banco; Gmail/Drive
  // disparam a coleta na nuvem (a descoberta acontece dentro dela).
  const capStyle: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: "var(--faint)", maxWidth: 240 };
  const acaoCaption =
    modo === "descobrir"
      ? `Enfileira os anexos pendentes do ${FONTE_LABEL[fonte]} para extração. Rodar de novo só pega os inéditos.`
      : fonte === "gmail"
        ? "Dispara a coleta do Gmail, que descobre e enfileira os anexos."
        : "Dispara a coleta do Drive: lista as pastas ativas e enfileira os vínculos.";
  const drenarCaption = "Processa a fila de anexos pendentes via Tika (todas as fontes).";

  async function handleAcao() {
    if (disabled) return;
    setFeedback(null);
    try {
      if (fonte === "nomus" || fonte === "effecti") {
        // Descoberta SQL direta no Edge: enfileira e devolve a contagem na hora.
        const r = await descobrir.mutateAsync({ fonte: fonte as FonteDescoberta });
        setFeedback({
          kind: "ok",
          message:
            r.inseridos > 0
              ? `${formatNumber(r.inseridos)} anexo(s) enfileirado(s) para extração.`
              : "Nenhum anexo novo: a fila já está completa.",
        });
      } else if (fonte === "gmail") {
        // Gmail: a descoberta acontece na coleta (runner). Dispara o workflow.
        await dispararGmail.mutateAsync();
        setFeedback({ kind: "ok", message: "Coleta do Gmail disparada · acompanhe em Execuções." });
      } else {
        // Drive: a descoberta roda no workflow proprio (coletar-drive.yml), que
        // lista as pastas ativas e enfileira os vinculos (sem Tika).
        await dispararDrive.mutateAsync();
        setFeedback({ kind: "ok", message: "Coleta do Drive disparada · descobre as pastas ativas." });
      }
    } catch (err) {
      let message = "Não foi possível executar a ação. Tente novamente.";
      if (err instanceof ApiError && err.status === 409) {
        message = "Já há uma coleta em andamento; aguarde a conclusão.";
      } else if (err instanceof ApiError && err.status === 422 && modo === "descobrir") {
        message = "Descoberta indisponível para esta fonte.";
      } else if (err instanceof ApiError && err.status === 502) {
        message = "Não foi possível acionar o coletor na nuvem. Tente novamente.";
      }
      setFeedback({ kind: "err", message });
    }
  }

  // Drain da fila: dispara o extrair-anexos.yml (Tika), que consome os vinculos
  // pendentes de TODAS as fontes. Separado da acao por fonte (acima): com a
  // decoupling 10/06, descobrir e extrair sao gatilhos independentes.
  async function handleDrenar() {
    if (dispararExtracao.isPending) return;
    setFeedback(null);
    try {
      await dispararExtracao.mutateAsync();
      setFeedback({ kind: "ok", message: "Extração disparada · processa a fila de anexos (Tika)." });
    } catch (err) {
      let message = "Não foi possível disparar a extração. Tente novamente.";
      if (err instanceof ApiError && err.status === 409) {
        message = "Já há uma extração em andamento; aguarde a conclusão.";
      } else if (err instanceof ApiError && err.status === 502) {
        message = "Não foi possível acionar a extração na nuvem. Tente novamente.";
      }
      setFeedback({ kind: "err", message });
    }
  }

  const errosCount = contagens?.erro ?? 0;

  return (
    <>
      {/* Disparo: descobrir por fonte + drenar a fila (Tika). */}
      <div className="card disparo-card" style={{ display: "grid", gap: 12, marginTop: 0 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <div
            className="filter-group segmented"
            role="group"
            aria-label="Fonte dos anexos"
          >
            {FONTES.map((f) => {
              const active = fonte === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  className={cn("btn", "btn-sm", active && "btn-primary")}
                  aria-pressed={active}
                  disabled={pending}
                  onClick={() => {
                    setFonte(f.value);
                    setFeedback(null);
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "flex-start",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAcao}
                disabled={disabled}
                aria-disabled={disabled}
                title={blocked ? blockedReason : undefined}
              >
                {pending ? (
                  <Loader2 className="spin" aria-hidden="true" />
                ) : modo === "descobrir" ? (
                  <Search aria-hidden="true" />
                ) : (
                  <Play aria-hidden="true" />
                )}
                <span>{pending ? (modo === "descobrir" ? "Descobrindo…" : "Disparando…") : actionLabel}</span>
              </button>
              <span className="helper" style={capStyle}>{acaoCaption}</span>
            </div>

            {/* Drain da fila (Tika): gatilho independente da descoberta por fonte. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleDrenar}
                disabled={dispararExtracao.isPending}
                aria-disabled={dispararExtracao.isPending}
                title="Processa a fila de anexos pendentes via Tika (todas as fontes)"
              >
                {dispararExtracao.isPending ? (
                  <Loader2 className="spin" aria-hidden="true" />
                ) : (
                  <FileText aria-hidden="true" />
                )}
                <span>{dispararExtracao.isPending ? "Disparando…" : "Extrair fila agora"}</span>
              </button>
              <span className="helper" style={capStyle}>{drenarCaption}</span>
            </div>
          </div>
        </div>

        {blocked ? (
          <span className="action-hint">
            <TriangleAlert aria-hidden="true" />
            {blockedReason}
          </span>
        ) : feedback ? (
          <span
            className="action-hint"
            style={{ color: feedback.kind === "err" ? "var(--err)" : "var(--ok)" }}
          >
            {feedback.kind === "err" ? (
              <TriangleAlert aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {feedback.message}
          </span>
        ) : null}
      </div>

      {/* KPIs por status (padrao StatCard do dashboard) */}
      <div className="section-title">
        <h3>Anexos na fila</h3>
        {!resumo.isLoading && (
          <span className="count">{formatNumber(contagens?.total ?? 0)}</span>
        )}
      </div>
      <div className="grid-dlh g4">
        <StatCard
          icon={<Clock aria-hidden="true" />}
          label="Pendentes"
          loading={resumo.isLoading}
          value={
            <span className="tnum" style={{ color: "var(--run)" }}>
              {formatNumber(contagens?.pendente ?? 0)}
            </span>
          }
          meta="aguardando extração"
        />
        <StatCard
          icon={<Check aria-hidden="true" />}
          label="Extraídos"
          loading={resumo.isLoading}
          value={
            <span className="tnum" style={{ color: "var(--ok)" }}>
              {formatNumber(contagens?.extraido ?? 0)}
            </span>
          }
          meta="texto disponível"
          metaTone="up"
        />
        <StatCard
          icon={<Copy aria-hidden="true" />}
          label="Herdados"
          loading={resumo.isLoading}
          value={<span className="tnum">{formatNumber(contagens?.herdado ?? 0)}</span>}
          meta="reaproveitados por dedup"
        />
        <StatCard
          icon={<TriangleAlert aria-hidden="true" />}
          label="Erros"
          loading={resumo.isLoading}
          value={
            <span
              className="tnum"
              style={{ color: errosCount > 0 ? "var(--err)" : undefined }}
            >
              {formatNumber(errosCount)}
            </span>
          }
          meta={errosCount > 0 ? "verifique a lista abaixo" : "sem falhas"}
          metaTone={errosCount > 0 ? "warn" : "up"}
        />
      </div>

      {/* Filtros (mesmo layout da tela Erros). */}
      <div className="section-title">
        <h3>Filtros</h3>
        {!resumo.isLoading && (
          <span className="count">{errosFiltrados.length}</span>
        )}
      </div>
      <div className="filter-bar">
        <OrigemFiltro value={filtroFonte} onChange={setFiltroFonte} />
      </div>

      {/* Tabela de erros de extracao */}
      <div className="tbl-wrap tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Fonte</th>
                <th>Extensão</th>
                <th>Motivo</th>
                <th>Quando</th>
              </tr>
            </thead>
            <tbody>
              {resumo.isLoading ? (
                Array.from({ length: 3 }).map((_, r) => (
                  <tr key={r}>
                    {Array.from({ length: 5 }).map((__, c) => (
                      <td key={c}>
                        <span className="skel skel-line" style={{ width: `${40 + ((r + c) % 4) * 14}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : errosFiltrados.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">
                      <Check aria-hidden="true" />
                      <h4>Nenhuma falha de extração</h4>
                      <p>
                        {filtroFonte === "todas"
                          ? "Todos os anexos descobertos foram extraídos sem erro."
                          : "Nenhuma falha de extração para a fonte selecionada."}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                errosFiltrados.map((e) => (
                  <tr key={e.id}>
                    <td className="cell-arquivo" title={e.nomeAnexo ?? undefined}>
                      {e.url ? (
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link"
                        >
                          <span className="trunc">{e.nomeAnexo ?? "—"}</span>
                          <ExternalLink aria-hidden="true" />
                        </a>
                      ) : (
                        <span className="trunc">{e.nomeAnexo ?? "—"}</span>
                      )}
                    </td>
                    <td>{e.fonte ? FONTE_LABEL[e.fonte as FontePainel] ?? e.fonte : "—"}</td>
                    <td className="mono">{e.extensao ?? "—"}</td>
                    <td className="sub">{e.erro ?? "—"}</td>
                    <td className="sub tnum">{formatDateTime(e.quando)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
    </>
  );
}
