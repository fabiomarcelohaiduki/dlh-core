"use client";

import { type CSSProperties, useState } from "react";
import {
  Ban,
  Check,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  Play,
  RotateCcw,
  ScanLine,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useDescobrir, useExtracaoResumo, useReprocessarErros } from "@/hooks/use-documentos";
import { useDispararDrive, useDispararExtracao, useDispararGmail, useDispararOcr } from "@/hooks/use-admin";
import { StatCard } from "@/components/cockpit/stat-card";
import {
  OrigemFiltro,
  type OrigemFiltroValue,
} from "@/components/cockpit/origem-filtro";
import type { FonteDescoberta, StatusItemExtracao } from "@/lib/api/documentos";
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
  const dispararOcr = useDispararOcr();
  const reprocessar = useReprocessarErros();
  const [fonte, setFonte] = useState<FontePainel>("nomus");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Filtro de origem da tabela (client-side, sobre a lista carregada).
  const [filtroFonte, setFiltroFonte] = useState<OrigemFiltroValue>("todas");
  // Status acionavel exibido na tabela; alimentado pelos cards clicaveis
  // (Erros / Inacessiveis / Aguardando OCR). Default 'erro'.
  const [filtroStatus, setFiltroStatus] = useState<StatusItemExtracao>("erro");

  const modo: ModoAcao = FONTES.find((f) => f.value === fonte)?.modo ?? "descobrir";
  // Acao por fonte (descobrir/coletar): NAO inclui o drain da fila (botao proprio).
  const pending = descobrir.isPending || dispararGmail.isPending || dispararDrive.isPending;
  // So Nomus depende de credencial; as demais nao tem esse gate aqui.
  const blocked = fonte === "nomus" && !nomusConfigurado;
  const blockedReason =
    "Cadastre e salve a chave do Nomus (em Fontes e credenciais) antes de descobrir anexos.";
  const disabled = blocked || pending;
  const contagens = resumo.data?.contagens;
  // Itens acionaveis (erro/inobtenivel/precisa_ocr) que o Edge devolve, ja
  // recortados pelo status selecionado nos cards e pela fonte selecionada.
  const itens = resumo.data?.itens ?? [];
  const itensStatus = itens.filter((i) => i.status === filtroStatus);
  const itensFiltrados =
    filtroFonte === "todas"
      ? itensStatus
      : itensStatus.filter((i) => i.fonte === filtroFonte);

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
  // Nomus: so processos tem anexos (pessoas nao passam por extracao), entao a
  // legenda diz "processos" em vez do generico "Nomus".
  const descobrirAlvo = fonte === "nomus" ? "dos processos do Nomus" : `do ${FONTE_LABEL[fonte]}`;
  const acaoCaption =
    modo === "descobrir"
      ? `Enfileira os anexos pendentes ${descobrirAlvo} para extração.`
      : fonte === "gmail"
        ? "Dispara a coleta do Gmail, que descobre e enfileira os anexos."
        : "Dispara a coleta do Drive: lista as pastas ativas e enfileira os vínculos.";

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

  // Drena a fila de OCR: dispara o extrair-ocr.yml (Tika com OCR ligado), que
  // consome SO os vinculos 'precisa_ocr' (escaneados/imagem) em lote pequeno,
  // separado do pipeline rapido. Gatilho manual (OCR e caro).
  async function handleOcr() {
    if (dispararOcr.isPending) return;
    setFeedback(null);
    try {
      await dispararOcr.mutateAsync();
      setFeedback({ kind: "ok", message: "Extração OCR disparada · processa os escaneados (precisa_ocr)." });
    } catch (err) {
      let message = "Não foi possível disparar a extração OCR. Tente novamente.";
      if (err instanceof ApiError && err.status === 409) {
        message = "Já há uma extração OCR em andamento; aguarde a conclusão.";
      } else if (err instanceof ApiError && err.status === 502) {
        message = "Não foi possível acionar a extração OCR na nuvem. Tente novamente.";
      }
      setFeedback({ kind: "err", message });
    }
  }

  // Re-enfileira os vinculos terminais (status alvo -> 'pendente') CONTEXTUAL
  // ao card selecionado: card Erros reprocessa 'erro', card Inacessíveis
  // reprocessa 'inobtenivel'. Respeita o filtro de origem da tabela ("todas"
  // reprocessa tudo; senao so a fonte). Zera o contador -> novo ciclo de 3x no
  // proximo drain. Em sucesso, o resumo invalida e os itens caem para Pendentes.
  async function handleReprocessar() {
    if (reprocessar.isPending) return;
    if (filtroStatus !== "erro" && filtroStatus !== "inobtenivel") return;
    setFeedback(null);
    const alvoFonte = filtroFonte === "todas" ? undefined : filtroFonte;
    const rotulo = filtroStatus === "inobtenivel" ? "inacessível(is)" : "com erro";
    try {
      const r = await reprocessar.mutateAsync({ fonte: alvoFonte, status: filtroStatus });
      setFeedback({
        kind: "ok",
        message:
          r.reprocessados > 0
            ? `${formatNumber(r.reprocessados)} anexo(s) ${rotulo} voltaram para a fila. Use "Extrair fila agora".`
            : `Nenhum anexo ${rotulo} para reprocessar.`,
      });
    } catch {
      setFeedback({ kind: "err", message: "Não foi possível reprocessar. Tente novamente." });
    }
  }

  const pendentesCount = contagens?.pendente ?? 0;
  const errosCount = contagens?.erro ?? 0;
  const inacessiveisCount = contagens?.inobtenivel ?? 0;
  const precisaOcrCount = contagens?.precisa_ocr ?? 0;

  // Total real do status selecionado (a lista vem capada em 200 no Edge).
  const STATUS_LABEL: Record<StatusItemExtracao, string> = {
    pendente: "Pendentes",
    extraido: "Extraídos",
    herdado: "Herdados",
    precisa_ocr: "Aguardando OCR",
    erro: "Erros",
    inobtenivel: "Inacessíveis",
  };
  const STATUS_COUNT: Record<StatusItemExtracao, number> = {
    pendente: contagens?.pendente ?? 0,
    extraido: contagens?.extraido ?? 0,
    herdado: contagens?.herdado ?? 0,
    precisa_ocr: precisaOcrCount,
    erro: errosCount,
    inobtenivel: inacessiveisCount,
  };
  const statusCount = STATUS_COUNT[filtroStatus];

  // Rotulos do botao de reprocesso contextual ao card (erro vs inacessivel).
  const reprocessarLabel = filtroStatus === "inobtenivel" ? "Reprocessar inacessíveis" : "Reprocessar erros";
  const reprocessarRotulo = filtroStatus === "inobtenivel" ? "inacessíveis" : "com erro";

  // Clicar num card seleciona o status exibido na tabela (e zera o filtro de
  // fonte, p/ nao esconder itens da nova selecao por engano).
  function selecionarStatus(status: StatusItemExtracao) {
    setFiltroStatus(status);
    setFiltroFonte("todas");
  }

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
      <div className="grid-dlh g6">
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
          onClick={() => selecionarStatus("pendente")}
          active={filtroStatus === "pendente"}
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
          onClick={() => selecionarStatus("extraido")}
          active={filtroStatus === "extraido"}
        />
        <StatCard
          icon={<Copy aria-hidden="true" />}
          label="Herdados"
          loading={resumo.isLoading}
          value={<span className="tnum">{formatNumber(contagens?.herdado ?? 0)}</span>}
          meta="reaproveitados por dedup"
          onClick={() => selecionarStatus("herdado")}
          active={filtroStatus === "herdado"}
        />
        <StatCard
          icon={<ScanLine aria-hidden="true" />}
          label="Aguardando OCR"
          loading={resumo.isLoading}
          value={
            <span
              className="tnum"
              style={{ color: precisaOcrCount > 0 ? "var(--run)" : undefined }}
            >
              {formatNumber(precisaOcrCount)}
            </span>
          }
          meta="escaneados · use Extrair OCR agora"
          onClick={() => selecionarStatus("precisa_ocr")}
          active={filtroStatus === "precisa_ocr"}
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
          meta={errosCount > 0 ? "clique para ver a lista" : "sem falhas"}
          metaTone={errosCount > 0 ? "warn" : "up"}
          onClick={() => selecionarStatus("erro")}
          active={filtroStatus === "erro"}
        />
        <StatCard
          icon={<Ban aria-hidden="true" />}
          label="Inacessíveis"
          loading={resumo.isLoading}
          value={<span className="tnum">{formatNumber(inacessiveisCount)}</span>}
          meta="removidos na origem · não reprocessam"
          onClick={() => selecionarStatus("inobtenivel")}
          active={filtroStatus === "inobtenivel"}
        />
      </div>

      {/* Lista do status selecionado nos cards (Erros / Inacessiveis / OCR). */}
      <div className="section-title">
        <h3>{STATUS_LABEL[filtroStatus]}</h3>
        {!resumo.isLoading && (
          <span className="count">
            {/* A lista vem capada em 200 (MAX_ITENS_RESUMO no Edge). Quando ha
                mais itens que o teto, mostra "200 de 600" p/ nao esconder o resto. */}
            {filtroFonte === "todas" && itensStatus.length < statusCount
              ? `${formatNumber(itensFiltrados.length)} de ${formatNumber(statusCount)}`
              : formatNumber(itensFiltrados.length)}
          </span>
        )}
      </div>
      <div className="filter-bar" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <OrigemFiltro value={filtroFonte} onChange={setFiltroFonte} />
        {/* Botao de reprocesso CONTEXTUAL ao card selecionado: 'erro' (transitorios)
            ou 'inobtenivel' (inacessiveis). So o manual ressuscita inacessivel; zera
            o contador -> novo ciclo de 3x. Respeita o filtro de origem. precisa_ocr
            usa o botao Extrair OCR (acima); demais status nao reprocessam. */}
        {(filtroStatus === "erro" || filtroStatus === "inobtenivel") &&
          (filtroStatus === "erro" ? errosCount : inacessiveisCount) > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: "auto" }}
              onClick={handleReprocessar}
              disabled={reprocessar.isPending}
              aria-disabled={reprocessar.isPending}
              title={
                filtroFonte === "todas"
                  ? `Volta todos os anexos ${reprocessarRotulo} para a fila de extração`
                  : `Volta os anexos ${reprocessarRotulo} do ${FONTE_LABEL[filtroFonte as FontePainel] ?? filtroFonte} para a fila`
              }
            >
              {reprocessar.isPending ? (
                <Loader2 className="spin" aria-hidden="true" />
              ) : (
                <RotateCcw aria-hidden="true" />
              )}
              <span>
                {reprocessar.isPending
                  ? "Reprocessando…"
                  : filtroFonte === "todas"
                    ? reprocessarLabel
                    : `${reprocessarLabel} · ${FONTE_LABEL[filtroFonte as FontePainel] ?? filtroFonte}`}
              </span>
            </button>
          )}
        {/* Card "Pendentes" selecionado: o botao de acao contextual e o disparo
            do extrair-anexos.yml (Tika), que drena a fila pendente de TODAS as
            fontes. Mesmo lugar/design do Reprocessar. */}
        {filtroStatus === "pendente" && pendentesCount > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: "auto" }}
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
            <span>{dispararExtracao.isPending ? "Disparando…" : "Extrair pendentes agora"}</span>
          </button>
        )}
        {/* Card "Aguardando OCR" selecionado: o botao de acao contextual e o
            disparo do extrair-ocr.yml (mesmo lugar/design do Reprocessar), pois
            precisa_ocr nao reprocessa — drena no passo OCR dedicado. */}
        {filtroStatus === "precisa_ocr" && precisaOcrCount > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={handleOcr}
            disabled={dispararOcr.isPending}
            aria-disabled={dispararOcr.isPending}
            title="Processa a fila de escaneados (precisa_ocr) com OCR ligado, em lote pequeno"
          >
            {dispararOcr.isPending ? (
              <Loader2 className="spin" aria-hidden="true" />
            ) : (
              <ScanLine aria-hidden="true" />
            )}
            <span>{dispararOcr.isPending ? "Disparando…" : "Extrair OCR agora"}</span>
          </button>
        )}
      </div>

      {/* Tabela de erros de extracao */}
      <div className="tbl-wrap tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Fonte</th>
                <th>Aviso</th>
                <th>Extensão</th>
                <th>Motivo</th>
                <th>Quando</th>
              </tr>
            </thead>
            <tbody>
              {resumo.isLoading ? (
                Array.from({ length: 3 }).map((_, r) => (
                  <tr key={r}>
                    {Array.from({ length: 6 }).map((__, c) => (
                      <td key={c}>
                        <span className="skel skel-line" style={{ width: `${40 + ((r + c) % 4) * 14}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : itensFiltrados.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">
                      <Check aria-hidden="true" />
                      <h4>Nenhum anexo em {STATUS_LABEL[filtroStatus].toLowerCase()}</h4>
                      <p>
                        {filtroFonte === "todas"
                          ? "Nada para mostrar neste status."
                          : "Nada para mostrar neste status para a fonte selecionada."}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                itensFiltrados.map((e) => (
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
                    <td>
                      {e.avisoUrl ? (
                        <a
                          href={e.avisoUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link"
                          title="Abrir o aviso no portal de origem"
                        >
                          <span>Abrir</span>
                          <ExternalLink aria-hidden="true" />
                        </a>
                      ) : (
                        <span className="sub">—</span>
                      )}
                    </td>
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
