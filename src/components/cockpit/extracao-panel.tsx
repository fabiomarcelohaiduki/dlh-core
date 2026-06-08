"use client";

import { useState } from "react";
import {
  Check,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useDescobrir, useExtracaoResumo } from "@/hooks/use-documentos";
import type { FonteDescoberta } from "@/lib/api/documentos";
import { ApiError } from "@/lib/api/client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

type Feedback = { kind: "ok" | "err"; message: string };

/** Rotulo amigavel por fonte (usado em textos da UI). */
const FONTE_LABEL: Record<FonteDescoberta, string> = {
  nomus: "Nomus",
  effecti: "Effecti",
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
  const [fonte, setFonte] = useState<FonteDescoberta>("nomus");
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const pending = descobrir.isPending;
  // So Nomus depende de credencial; Effecti descobre direto dos avisos do banco.
  const blocked = fonte === "nomus" && !nomusConfigurado;
  const blockedReason =
    "Cadastre e salve a chave do Nomus (em Fontes e credenciais) antes de descobrir anexos.";
  const disabled = blocked || pending;
  const contagens = resumo.data?.contagens;
  const erros = resumo.data?.erros ?? [];

  async function handleDescobrir() {
    if (disabled) return;
    setFeedback(null);
    try {
      const r = await descobrir.mutateAsync({ fonte });
      setFeedback({
        kind: "ok",
        message:
          r.inseridos > 0
            ? `${formatNumber(r.inseridos)} anexo(s) enfileirado(s) para extração.`
            : "Nenhum anexo novo: a fila já está completa.",
      });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 422
          ? "Descoberta indisponível para esta fonte."
          : "Não foi possível descobrir anexos. Tente novamente.";
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
          <div style={{ color: "var(--muted)", fontSize: 12 }}>
            Camada 1: enfileira os anexos e extrai o texto. Nomus e Effecti caem na mesma fila; o
            conteúdo é processado em segundo plano pelo runner de nuvem.
          </div>
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

      {/* Acao de descoberta */}
      <div className="action-col">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <select
            value={fonte}
            onChange={(e) => {
              setFonte(e.target.value as FonteDescoberta);
              setFeedback(null);
            }}
            disabled={pending}
            aria-label="Fonte dos anexos a descobrir"
          >
            <option value="nomus">{FONTE_LABEL.nomus}</option>
            <option value="effecti">{FONTE_LABEL.effecti}</option>
          </select>
          <button
            type="button"
            className="btn"
            onClick={handleDescobrir}
            disabled={disabled}
            aria-disabled={disabled}
            title={blocked ? blockedReason : undefined}
          >
            {pending ? <Loader2 className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
            <span>
              {pending ? "Descobrindo…" : `Descobrir anexos pendentes · ${FONTE_LABEL[fonte]}`}
            </span>
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
