"use client";

import { useState } from "react";
import {
  Check,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useDescobrir, useExtracaoResumo } from "@/hooks/use-documentos";
import { useDispararDrive, useDispararExtracao, useDispararGmail } from "@/hooks/use-admin";
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

  const actionLabel =
    modo === "descobrir"
      ? `Descobrir anexos pendentes · ${FONTE_LABEL[fonte]}`
      : fonte === "gmail"
        ? "Coletar Gmail agora"
        : "Coletar Drive agora";

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

  return (
    <div className="card" style={{ display: "grid", gap: 16 }}>
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
          <FileText aria-hidden="true" />
        </div>
        <div style={{ flex: 1 }}>
          <b style={{ fontSize: 14.5 }}>Extração de anexos</b>
        </div>
      </div>

      {/* Contagens por status */}
      <div className="extr-stats" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <StatusChip label="Pendentes" value={contagens?.pendente} tone="run" loading={resumo.isLoading} />
        <StatusChip label="Extraídos" value={contagens?.extraido} tone="ok" loading={resumo.isLoading} />
        <StatusChip label="Herdados" value={contagens?.herdado} tone="default" loading={resumo.isLoading} />
        <StatusChip label="Erros" value={contagens?.erro} tone="err" loading={resumo.isLoading} />
        <StatusChip label="Total" value={contagens?.total} tone="default" loading={resumo.isLoading} />
      </div>

      {/* Acao de descoberta / disparo por fonte */}
      <div className="action-col">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <select
            value={fonte}
            onChange={(e) => {
              setFonte(e.target.value as FontePainel);
              setFeedback(null);
            }}
            disabled={pending}
            aria-label="Fonte dos anexos a descobrir"
          >
            {FONTES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
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

          {/* Drain da fila (Tika): gatilho independente da descoberta por fonte. */}
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

        <div className="helper">
          As 4 fontes já descobrem sozinhas na coleta. Aqui é o disparo manual da descoberta: Nomus e
          Effecti enfileiram na hora (descoberta instantânea); Gmail e Drive disparam a coleta própria
          na nuvem (a descoberta deles depende do runner). &ldquo;Extrair fila agora&rdquo; processa os
          anexos pendentes de todas as fontes via Tika.
        </div>
      </div>

      {/* Tabela de erros de extracao */}
      <div style={{ display: "grid", gap: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <b style={{ fontSize: 13 }}>Anexos com falha na extração</b>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => resumo.refetch()}
            disabled={resumo.isFetching}
            aria-label="Atualizar lista de erros"
          >
            <RefreshCw className={cn(resumo.isFetching && "spin")} aria-hidden="true" />
            <span>Atualizar</span>
          </button>
        </div>

        <div className="tbl-wrap tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Extensão</th>
                <th>Origem</th>
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
              ) : erros.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">
                      <Check aria-hidden="true" />
                      <h4>Nenhuma falha de extração</h4>
                      <p>Todos os anexos descobertos foram extraídos sem erro.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                erros.map((e) => (
                  <tr key={e.id}>
                    <td title={e.nomeAnexo ?? undefined}>{e.nomeAnexo ?? "—"}</td>
                    <td className="mono">{e.extensao ?? "—"}</td>
                    <td className="mono">{e.processoId ?? "—"}</td>
                    <td className="sub">{e.erro ?? "—"}</td>
                    <td className="sub tnum">{formatDateTime(e.quando)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatusChip({
  label,
  value,
  tone,
  loading,
}: {
  label: string;
  value: number | undefined;
  tone: "ok" | "err" | "run" | "default";
  loading: boolean;
}) {
  const color =
    tone === "ok"
      ? "var(--ok)"
      : tone === "err"
        ? "var(--err)"
        : tone === "run"
          ? "var(--run)"
          : "var(--muted)";
  return (
    <div
      style={{
        display: "grid",
        gap: 2,
        padding: "8px 12px",
        borderRadius: 9,
        border: "1px solid var(--line)",
        minWidth: 92,
      }}
    >
      <span style={{ fontSize: 11, color: "var(--muted)" }}>{label}</span>
      {loading ? (
        <span className="skel skel-line" style={{ width: 40, height: 18 }} />
      ) : (
        <b className="tnum" style={{ fontSize: 18, color }}>
          {formatNumber(value ?? 0)}
        </b>
      )}
    </div>
  );
}
