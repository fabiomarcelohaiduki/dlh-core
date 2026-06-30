"use client";

// =====================================================================
// ExtracaoFilaView — guia "Fila de extração" do submódulo Coleta.
//
// Única tela de extração do cockpit (a antiga tela standalone foi removida).
// Roda sobre o WorkbenchTemplate com leitura PAGINADA server-side por keyset
// (recall total, sem cap de 200).
// Fonte da verdade = documento_vinculos (1 anexo por linha); não há recurso
// aqui (a tabela não tem a coluna), só fonte + status + busca.
//
//   - Tabs de fonte (Todas/Effecti/Nomus/Gmail/Drive): filtra a tabela E
//     determina o disparo manual no header (Descobrir / Coletar agora).
//   - 7 cards de status (StatCard): clicar filtra a tabela pelo status E troca
//     o botão de ação contextual (Pendentes→Extrair pendentes; OCR→Extrair OCR;
//     Erros/Inacessíveis→Reprocessar/Ignorar todos; Ignorados→Restaurar).
//   - Tabela re-vestida (Arquivo/Fonte/Extensão/Motivo/Quando/Ações) com
//     CursorPager no rodapé. Ações por linha: Substituir link (Effecti) e
//     Ignorar (erro/inacessível, confirmação inline em 2 cliques).
//   - Botão "Parâmetros" abre o drawer com Agendamento + Config da camada 1.
//
// As mutações reusam os hooks da Extração (que invalidam o resumo); aqui
// também invalidamos extracaoFilaKeys.all para a página refletir na hora.
// =====================================================================

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  Clock,
  Copy,
  ExternalLink,
  EyeOff,
  FileText,
  Link2,
  Loader2,
  RotateCcw,
  ScanLine,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { StatCard } from "@/components/cockpit/stat-card";
import { SubstituirLinkModal } from "@/components/cockpit/substituir-link-modal";
import { ExtracaoConfigForm } from "@/components/cockpit/extracao-config-form";
import {
  useDescobrir,
  useIgnorarAnexo,
  useIgnorarEmMassa,
  useReprocessarErros,
} from "@/hooks/use-documentos";
import { useDispararExtracao, useDispararOcr } from "@/hooks/use-admin";
import { useExtracaoFila, extracaoFilaKeys } from "@/hooks/use-extracao-fila";
import type {
  ExtracaoFilaCursor,
  ExtracaoItem,
  FonteReprocessavel,
  StatusItemExtracao,
} from "@/lib/api/documentos";
import type { ConfigExtracaoState } from "@/lib/api/types";
import { ApiError } from "@/lib/api/client";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { WorkbenchScopeRef } from "./use-workbench-layout";
import { WorkbenchTemplate } from "./workbench-template";
import { TOOLBAR_SEARCH_CLASS } from "./table-toolbar-menus";
import { CursorPager } from "./table-pagination";
import { CockpitToast } from "./cockpit-toast";

type FonteTab = "todas" | FonteReprocessavel;

const FONTE_TABS: { value: FonteTab; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "effecti", label: "Effecti" },
  { value: "nomus", label: "Nomus" },
  { value: "gmail", label: "Gmail" },
  { value: "drive", label: "Drive" },
];

const FONTE_LABEL: Record<FonteReprocessavel, string> = {
  effecti: "Effecti",
  nomus: "Nomus",
  gmail: "Gmail",
  drive: "Drive",
};

const STATUS_LABEL: Record<StatusItemExtracao, string> = {
  pendente: "Pendentes",
  extraido: "Extraídos",
  herdado: "Herdados",
  precisa_ocr: "Aguardando OCR",
  erro: "Erros",
  inobtenivel: "Inacessíveis",
  ignorado: "Ignorados",
};

const FILA_BLOCKS = ["fontes", "busca", "filtros", "acao-principal"] as const;

const FILA_SCOPE: WorkbenchScopeRef = {
  modulo: "ingestao",
  tela: "coleta",
  guia: "extracao",
};

const PAGE_SIZE = 50;

type Toast = { kind: "ok" | "err" | "info"; message: string } | null;

export function ExtracaoFilaView({
  nomusConfigurado,
  configExtracao,
}: {
  nomusConfigurado: boolean;
  configExtracao: ConfigExtracaoState;
}) {
  const queryClient = useQueryClient();

  // Filtros (server-side): fonte das Tabs, status dos cards, busca textual.
  const [fonte, setFonte] = useState<FonteTab>("todas");
  const [status, setStatus] = useState<StatusItemExtracao>("pendente");
  const [busca, setBusca] = useState("");

  // Paginação por cursor server-side (mesmo padrão da guia Dados): pilha de
  // cursores; avançar empilha o atual, voltar desempilha.
  const [cursors, setCursors] = useState<readonly (ExtracaoFilaCursor | null)[]>([]);
  const [currentCursor, setCurrentCursor] = useState<ExtracaoFilaCursor | null>(null);

  // Confirmações inline (2 cliques) e item Effecti em correção de link.
  const [confirmIgnorarId, setConfirmIgnorarId] = useState<string | null>(null);
  const [confirmRestaurar, setConfirmRestaurar] = useState(false);
  const [confirmIgnorarMassa, setConfirmIgnorarMassa] = useState(false);
  const [linkAlvo, setLinkAlvo] = useState<ExtracaoItem | null>(null);

  // Drawer de parâmetros (Agendamento + Config), espelho do ExtracaoView.
  const [paramsAberto, setParamsAberto] = useState(false);
  const paramsTriggerRef = useRef<HTMLButtonElement>(null);

  const [toast, setToast] = useState<Toast>(null);

  // Mutações reusadas da Extração + disparos de coleta/extração.
  const descobrir = useDescobrir();
  const dispararExtracao = useDispararExtracao();
  const dispararOcr = useDispararOcr();
  const reprocessar = useReprocessarErros();
  const ignorar = useIgnorarAnexo();
  const ignorarMassa = useIgnorarEmMassa();

  const fila = useExtracaoFila({
    fonte: fonte === "todas" ? null : fonte,
    status,
    busca: busca.trim() || null,
    cursor: currentCursor,
    limit: PAGE_SIZE,
  });

  const itens = fila.data?.itens ?? [];
  const nextCursor = fila.data?.nextCursor ?? null;
  const contagens = fila.data?.contagens;
  const pageNumber = cursors.length + 1;

  // Trocar fonte/status/busca zera o cursor e fecha confirmações.
  useEffect(() => {
    setCursors([]);
    setCurrentCursor(null);
    setConfirmIgnorarId(null);
    setConfirmRestaurar(false);
    setConfirmIgnorarMassa(false);
  }, [fonte, status, busca]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // Drawer: fecha no Escape e devolve foco ao botão que abriu.
  useEffect(() => {
    if (!paramsAberto) return;
    const trigger = paramsTriggerRef.current;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setParamsAberto(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [paramsAberto]);

  // Invalida a página da fila após qualquer mutação (os hooks só invalidam o
  // resumo da Extração). Mantém os contadores e a lista coerentes na hora.
  function refazerFila() {
    queryClient.invalidateQueries({ queryKey: extracaoFilaKeys.all });
  }

  function handleNextPage() {
    if (!nextCursor) return;
    setCursors((prev) => [...prev, currentCursor]);
    setCurrentCursor(nextCursor);
  }
  function handlePrevPage() {
    if (cursors.length === 0) return;
    const previous = cursors[cursors.length - 1];
    setCursors((prev) => prev.slice(0, -1));
    setCurrentCursor(previous);
  }

  // Clicar num card seleciona o status da tabela (e zera o filtro de fonte, p/
  // não esconder itens da nova seleção).
  function selecionarStatus(s: StatusItemExtracao) {
    setStatus(s);
    setFonte("todas");
  }

  // ---- Disparo por fonte (header): "Trazer para a fila" (enfileira os anexos
  // já coletados em documento_vinculos para extração). Só o Nomus precisa de
  // disparo MANUAL — Effecti descobre sozinho pós-coleta e Gmail/Drive já
  // entregam a lista pronta. Para essas, o botão fica desabilitado e informa
  // que o enfileiramento é automático. Nomus exige a credencial salva.
  const disparando = descobrir.isPending;
  const nomusBloqueado = fonte === "nomus" && !nomusConfigurado;
  const acaoAutomatica = fonte === "effecti" || fonte === "gmail" || fonte === "drive";
  const acaoLabel =
    fonte === "nomus"
      ? "Trazer para a fila"
      : acaoAutomatica
        ? "Enfileira automático"
        : "Selecione Nomus para enfileirar";
  const acaoDisabled = fonte !== "nomus" || nomusBloqueado || disparando;
  const acaoTitle =
    fonte === "nomus"
      ? nomusBloqueado
        ? "Cadastre a chave do Nomus (em Integrações) antes de enfileirar"
        : "Varre os processos já coletados do Nomus e enfileira os anexos para extração"
      : acaoAutomatica
        ? `O ${FONTE_LABEL[fonte]} enfileira os anexos automaticamente após cada coleta`
        : "Só o Nomus precisa de disparo manual; as demais fontes enfileiram automático";

  async function handleDisparoFonte() {
    if (fonte !== "nomus") return; // só o Nomus precisa de disparo manual
    if (nomusBloqueado) {
      setToast({ kind: "err", message: "Cadastre e salve a chave do Nomus (em Integrações) antes de enfileirar." });
      return;
    }
    if (disparando) return;
    try {
      const r = await descobrir.mutateAsync({ fonte: "nomus" });
      refazerFila();
      setToast({
        kind: "ok",
        message:
          r.inseridos > 0
            ? `${formatNumber(r.inseridos)} anexo(s) enfileirado(s) para extração.`
            : "Nenhum anexo novo: a fila já está completa.",
      });
    } catch (err) {
      let message = "Não foi possível enfileirar os anexos. Tente novamente.";
      if (err instanceof ApiError && err.status === 409) message = "Já há uma descoberta em andamento; aguarde a conclusão.";
      else if (err instanceof ApiError && err.status === 422) message = "Descoberta indisponível para esta fonte.";
      setToast({ kind: "err", message });
    }
  }

  // ---- Ação contextual por status (toolbar/filtros) ----
  const alvoFonte: FonteReprocessavel | undefined = fonte === "todas" ? undefined : fonte;

  // Drena a fila pendente (Tika, todas as fontes).
  async function handleDrenar() {
    if (dispararExtracao.isPending) return;
    try {
      await dispararExtracao.mutateAsync();
      refazerFila();
      setToast({ kind: "ok", message: "Extração disparada · processa a fila de anexos (Tika)." });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? "Já há uma extração em andamento; aguarde a conclusão."
          : "Não foi possível disparar a extração. Tente novamente.";
      setToast({ kind: "err", message });
    }
  }

  // Drena a fila de OCR (Tika com OCR, só precisa_ocr).
  async function handleOcr() {
    if (dispararOcr.isPending) return;
    try {
      await dispararOcr.mutateAsync();
      refazerFila();
      setToast({ kind: "ok", message: "Extração OCR disparada · processa os escaneados (precisa_ocr)." });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? "Já há uma extração OCR em andamento; aguarde a conclusão."
          : "Não foi possível disparar a extração OCR. Tente novamente.";
      setToast({ kind: "err", message });
    }
  }

  // Re-enfileira os vínculos terminais (status alvo -> 'pendente') contextual
  // ao card. Respeita o filtro de fonte ("todas" = tudo).
  async function handleReprocessar() {
    if (reprocessar.isPending) return;
    if (status !== "erro" && status !== "inobtenivel" && status !== "ignorado") return;
    const rotulo = status === "inobtenivel" ? "inacessível(is)" : status === "ignorado" ? "ignorado(s)" : "com erro";
    try {
      const r = await reprocessar.mutateAsync({ fonte: alvoFonte, status });
      setConfirmRestaurar(false);
      refazerFila();
      setToast({
        kind: "ok",
        message:
          r.reprocessados > 0
            ? `${formatNumber(r.reprocessados)} anexo(s) ${rotulo} voltaram para a fila.`
            : `Nenhum anexo ${rotulo} para reprocessar.`,
      });
    } catch {
      setToast({ kind: "err", message: "Não foi possível reprocessar. Tente novamente." });
    }
  }

  // Marca TODOS os anexos do card (status+fonte) como 'ignorado'. Só erro/
  // inacessível. Confirmação inline em 2 cliques.
  async function handleIgnorarMassa() {
    if (ignorarMassa.isPending) return;
    if (status !== "erro" && status !== "inobtenivel") return;
    const rotulo = status === "inobtenivel" ? "inacessível(is)" : "com erro";
    try {
      const r = await ignorarMassa.mutateAsync({ fonte: alvoFonte, status });
      setConfirmIgnorarMassa(false);
      refazerFila();
      setToast({
        kind: "ok",
        message:
          r.ignorados > 0
            ? `${formatNumber(r.ignorados)} anexo(s) ${rotulo} ignorado(s) · reversível no card Ignorados.`
            : `Nenhum anexo ${rotulo} para ignorar.`,
      });
    } catch {
      setToast({ kind: "err", message: "Não foi possível ignorar os anexos. Tente novamente." });
    }
  }

  // Marca UM anexo como 'ignorado'. Confirmação inline na própria linha.
  async function handleIgnorar(item: ExtracaoItem) {
    if (ignorar.isPending) return;
    try {
      await ignorar.mutateAsync(item.id);
      setConfirmIgnorarId(null);
      refazerFila();
      setToast({ kind: "ok", message: "Anexo ignorado · disponível no card Ignorados para reverter." });
    } catch {
      setToast({ kind: "err", message: "Não foi possível ignorar o anexo. Tente novamente." });
    }
  }

  const statusCount = (s: StatusItemExtracao): number => contagens?.porStatus[s] ?? 0;
  const fonteCount = (t: FonteTab): number =>
    t === "todas" ? contagens?.total ?? 0 : contagens?.porFonte[t] ?? 0;

  // Total honesto p/ o rodapé: com fonte específica OU busca ativa, a
  // interseção fonte×status não é conhecida (as contagens são quebras
  // independentes) -> "Página X". Com "Todas" e sem busca, é porStatus[status].
  const filaTotal =
    busca.trim() || fonte !== "todas" ? undefined : statusCount(status);
  const filaTotalPages =
    filaTotal && filaTotal > 0 ? Math.max(1, Math.ceil(filaTotal / PAGE_SIZE)) : undefined;

  const capStyle: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: "var(--faint)" };

  const reprocessarLabel =
    status === "inobtenivel" ? "Reprocessar inacessíveis" : status === "ignorado" ? "Restaurar ignorados" : "Reprocessar erros";

  return (
    <>
      <WorkbenchTemplate
        scope={FILA_SCOPE}
        workbenchKey="coleta-extracao"
          toastClassName="bottom-[5.5rem]"
          blocks={FILA_BLOCKS}
          actionLabel={disparando ? "Enfileirando…" : acaoLabel}
          onAction={handleDisparoFonte}
          actionDisabled={acaoDisabled}
          actionTitle={acaoTitle}
          headerAux={
            <button
              ref={paramsTriggerRef}
              type="button"
              className="btn btn-sm"
              onClick={() => setParamsAberto(true)}
              aria-haspopup="dialog"
              aria-expanded={paramsAberto}
            >
              <SlidersHorizontal aria-hidden="true" />
              <span>Parâmetros</span>
            </button>
          }
          banner={renderCards()}
          slots={{
            fontes: (
              <Tabs<FonteTab>
                ariaLabel="Filtrar a fila por fonte"
                className="border-b-0 px-0"
                value={fonte}
                onValueChange={setFonte}
                items={FONTE_TABS.map((t) => ({ value: t.value, label: t.label, count: fonteCount(t.value) }))}
              />
            ),
            busca: (
              <input
                type="search"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por nome do anexo"
                aria-label="Buscar anexos na fila de extração"
                className={TOOLBAR_SEARCH_CLASS}
              />
            ),
            filtros: renderAcaoContextual(),
          }}
        >
        {renderFilaTabela()}
      </WorkbenchTemplate>

      {linkAlvo ? <SubstituirLinkModal item={linkAlvo} onClose={() => setLinkAlvo(null)} /> : null}

      {paramsAberto ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Parâmetros de extração"
          onClick={() => setParamsAberto(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "8vh 16px 16px",
            overflowY: "auto",
          }}
        >
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 100%)", maxWidth: 560 }}>
            <div className="section-title" style={{ margin: "0 0 16px" }}>
              <h3>Parâmetros de extração</h3>
              <button
                type="button"
                className="btn btn-sm btn-icon"
                style={{ marginLeft: "auto" }}
                onClick={() => setParamsAberto(false)}
                aria-label="Fechar"
                title="Fechar"
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <div style={{ display: "grid", gap: 16 }}>
              <ExtracaoConfigForm initial={configExtracao} />
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <CockpitToast kind={toast.kind} message={toast.message} className="bottom-[5.5rem]" /> : null}
    </>
  );

  // ------------------------------------------------------------------
  // Cards de status (banner do card, abaixo do cabeçalho): clicar filtra a
  // tabela pelo status E troca a ação contextual. Grid de 7 colunas alinhado.
  // ------------------------------------------------------------------
  function renderCards() {
    return (
      <div className="grid-dlh g7">
        <StatCard
          icon={<Clock aria-hidden="true" />}
          label="Pendentes"
          loading={fila.isLoading}
          value={<span className="tnum" style={{ color: "var(--run)" }}>{formatNumber(statusCount("pendente"))}</span>}
          meta="aguardando extração"
          onClick={() => selecionarStatus("pendente")}
          active={status === "pendente"}
        />
        <StatCard
          icon={<Check aria-hidden="true" />}
          label="Extraídos"
          loading={fila.isLoading}
          value={<span className="tnum" style={{ color: "var(--ok)" }}>{formatNumber(statusCount("extraido"))}</span>}
          meta="texto disponível"
          metaTone="up"
          onClick={() => selecionarStatus("extraido")}
          active={status === "extraido"}
        />
        <StatCard
          icon={<Copy aria-hidden="true" />}
          label="Herdados"
          loading={fila.isLoading}
          value={<span className="tnum">{formatNumber(statusCount("herdado"))}</span>}
          meta="reaproveitados por dedup"
          onClick={() => selecionarStatus("herdado")}
          active={status === "herdado"}
        />
        <StatCard
          icon={<ScanLine aria-hidden="true" />}
          label="Aguardando OCR"
          loading={fila.isLoading}
          value={<span className="tnum" style={{ color: statusCount("precisa_ocr") > 0 ? "var(--run)" : undefined }}>{formatNumber(statusCount("precisa_ocr"))}</span>}
          meta="escaneados · use Extrair OCR agora"
          onClick={() => selecionarStatus("precisa_ocr")}
          active={status === "precisa_ocr"}
        />
        <StatCard
          icon={<TriangleAlert aria-hidden="true" />}
          label="Erros"
          loading={fila.isLoading}
          value={<span className="tnum" style={{ color: statusCount("erro") > 0 ? "var(--err)" : undefined }}>{formatNumber(statusCount("erro"))}</span>}
          meta={statusCount("erro") > 0 ? "clique para ver a lista" : "sem falhas"}
          metaTone={statusCount("erro") > 0 ? "warn" : "up"}
          onClick={() => selecionarStatus("erro")}
          active={status === "erro"}
        />
        <StatCard
          icon={<Ban aria-hidden="true" />}
          label="Inacessíveis"
          loading={fila.isLoading}
          value={<span className="tnum">{formatNumber(statusCount("inobtenivel"))}</span>}
          meta="removidos na origem · não reprocessam"
          onClick={() => selecionarStatus("inobtenivel")}
          active={status === "inobtenivel"}
        />
        <StatCard
          icon={<EyeOff aria-hidden="true" />}
          label="Ignorados"
          loading={fila.isLoading}
          value={<span className="tnum">{formatNumber(statusCount("ignorado"))}</span>}
          meta="dispensados pelo humano · reversível"
          onClick={() => selecionarStatus("ignorado")}
          active={status === "ignorado"}
        />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Ação contextual ao card selecionado (slot filtros, à direita da toolbar):
  // Pendentes→Extrair pendentes; OCR→Extrair OCR; Erros/Inacessíveis→
  // Reprocessar + Ignorar todos; Ignorados→Restaurar (2 cliques).
  // ------------------------------------------------------------------
  function renderAcaoContextual() {
    const podeReprocessar =
      (status === "erro" || status === "inobtenivel" || status === "ignorado") && statusCount(status) > 0;
    const podeIgnorarMassa = (status === "erro" || status === "inobtenivel") && statusCount(status) > 0;

    return (
      <span className="ml-auto inline-flex items-center gap-2.5">
        {status === "pendente" && statusCount("pendente") > 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleDrenar}
            disabled={dispararExtracao.isPending}
            aria-disabled={dispararExtracao.isPending}
            title="Processa a fila de anexos pendentes via Tika (todas as fontes)"
          >
            {dispararExtracao.isPending ? <Loader2 className="spin" aria-hidden="true" /> : <FileText aria-hidden="true" />}
            <span>{dispararExtracao.isPending ? "Disparando…" : "Extrair pendentes agora"}</span>
          </button>
        ) : null}

        {status === "precisa_ocr" && statusCount("precisa_ocr") > 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleOcr}
            disabled={dispararOcr.isPending}
            aria-disabled={dispararOcr.isPending}
            title="Processa a fila de escaneados (precisa_ocr) com OCR ligado, em lote pequeno"
          >
            {dispararOcr.isPending ? <Loader2 className="spin" aria-hidden="true" /> : <ScanLine aria-hidden="true" />}
            <span>{dispararOcr.isPending ? "Disparando…" : "Extrair OCR agora"}</span>
          </button>
        ) : null}

        {podeReprocessar ? (
          status === "ignorado" && confirmRestaurar ? (
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleReprocessar}
                disabled={reprocessar.isPending}
                aria-disabled={reprocessar.isPending}
                title="Confirmar: voltar os anexos ignorados para a fila"
              >
                {reprocessar.isPending ? <Loader2 className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
                <span>{reprocessar.isPending ? "Restaurando…" : "Confirmar restaurar"}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                onClick={() => setConfirmRestaurar(false)}
                disabled={reprocessar.isPending}
                aria-label="Cancelar"
                title="Cancelar"
              >
                <X aria-hidden="true" />
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={status === "ignorado" ? () => setConfirmRestaurar(true) : handleReprocessar}
              disabled={reprocessar.isPending}
              aria-disabled={reprocessar.isPending}
              title={
                fonte === "todas"
                  ? `Volta os anexos do status para a fila de extração`
                  : `Volta os anexos do status no ${FONTE_LABEL[fonte]} para a fila`
              }
            >
              {reprocessar.isPending ? <Loader2 className="spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
              <span>{reprocessar.isPending ? "Reprocessando…" : fonte === "todas" ? reprocessarLabel : `${reprocessarLabel} · ${FONTE_LABEL[fonte]}`}</span>
            </button>
          )
        ) : null}

        {podeIgnorarMassa ? (
          confirmIgnorarMassa ? (
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleIgnorarMassa}
                disabled={ignorarMassa.isPending}
                aria-disabled={ignorarMassa.isPending}
                title="Confirmar: marcar todos os anexos deste card como ignorados"
              >
                {ignorarMassa.isPending ? <Loader2 className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
                <span>{ignorarMassa.isPending ? "Ignorando…" : "Confirmar ignorar"}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                onClick={() => setConfirmIgnorarMassa(false)}
                disabled={ignorarMassa.isPending}
                aria-label="Cancelar"
                title="Cancelar"
              >
                <X aria-hidden="true" />
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirmIgnorarMassa(true)}
              title={
                fonte === "todas"
                  ? "Marca todos os anexos deste card como ignorados (sai das listas, reversível)"
                  : `Marca os anexos deste card no ${FONTE_LABEL[fonte]} como ignorados`
              }
            >
              <EyeOff aria-hidden="true" />
              <span>{fonte === "todas" ? "Ignorar todos" : `Ignorar todos · ${FONTE_LABEL[fonte]}`}</span>
            </button>
          )
        ) : null}
      </span>
    );
  }

  // ------------------------------------------------------------------
  // Tabela paginada da fila + rodapé CursorPager.
  // ------------------------------------------------------------------
  function renderFilaTabela() {
    return (
      <>
        <div className="tbl-wrap tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Fonte</th>
                <th>Extensão</th>
                <th>Motivo</th>
                <th>Quando</th>
                <th aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {fila.isLoading ? (
                Array.from({ length: 4 }).map((_, r) => (
                  <tr key={r}>
                    {Array.from({ length: 6 }).map((__, c) => (
                      <td key={c}>
                        <span className="skel skel-line" style={{ width: `${40 + ((r + c) % 4) * 14}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : fila.isError ? (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">
                      <TriangleAlert aria-hidden="true" />
                      <h4>Não foi possível carregar a fila</h4>
                      <p>
                        <button type="button" className="btn btn-sm" onClick={() => fila.refetch()}>
                          Tentar de novo
                        </button>
                      </p>
                    </div>
                  </td>
                </tr>
              ) : itens.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">
                      <Check aria-hidden="true" />
                      <h4>Nenhum anexo em {STATUS_LABEL[status].toLowerCase()}</h4>
                      <p style={capStyle}>
                        {fonte === "todas" && !busca.trim()
                          ? "Nada para mostrar neste status."
                          : "Nada para mostrar neste status com o filtro atual."}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                itens.map((e) => (
                  <tr key={e.id}>
                    <td className="cell-arquivo" title={e.nomeAnexo ?? undefined}>
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noopener noreferrer" className="link">
                          <span className="trunc">{e.nomeAnexo ?? "—"}</span>
                          <ExternalLink aria-hidden="true" />
                        </a>
                      ) : (
                        <span className="trunc">{e.nomeAnexo ?? "—"}</span>
                      )}
                    </td>
                    <td>
                      {e.fonte === "effecti" && e.avisoUrl ? (
                        <a href={e.avisoUrl} target="_blank" rel="noopener noreferrer" className="link" title="Abrir o aviso no Effecti">
                          <span>{FONTE_LABEL.effecti}</span>
                          <ExternalLink aria-hidden="true" />
                        </a>
                      ) : e.fonte ? (
                        FONTE_LABEL[e.fonte as FonteReprocessavel] ?? e.fonte
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="mono">{e.extensao ?? "—"}</td>
                    <td
                      className="sub"
                      title={e.erro ?? undefined}
                      style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {e.erro ?? "—"}
                    </td>
                    <td className="sub tnum">{formatDateTime(e.quando)}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                        {e.fonte === "effecti" ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm btn-icon"
                            onClick={() => setLinkAlvo(e)}
                            aria-label="Substituir o link quebrado deste anexo"
                            title="Substituir o link quebrado deste anexo"
                          >
                            <Link2 aria-hidden="true" />
                          </button>
                        ) : null}
                        {status === "erro" || status === "inobtenivel" ? (
                          confirmIgnorarId === e.id ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm btn-icon"
                                onClick={() => handleIgnorar(e)}
                                disabled={ignorar.isPending}
                                aria-disabled={ignorar.isPending}
                                aria-label="Confirmar ignorar este anexo"
                                title="Confirmar: ignorar este anexo"
                              >
                                {ignorar.isPending ? <Loader2 className="spin" aria-hidden="true" /> : <Check aria-hidden="true" style={{ color: "var(--err)" }} />}
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm btn-icon"
                                onClick={() => setConfirmIgnorarId(null)}
                                disabled={ignorar.isPending}
                                aria-label="Cancelar"
                                title="Cancelar"
                              >
                                <X aria-hidden="true" />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm btn-icon"
                              onClick={() => setConfirmIgnorarId(e.id)}
                              aria-label="Ignorar este anexo (remove da fila)"
                              title="Ignorar: marca como dispensável e remove da lista"
                            >
                              <EyeOff aria-hidden="true" />
                            </button>
                          )
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <CursorPager
          page={pageNumber}
          hasPrev={cursors.length > 0}
          hasNext={nextCursor !== null}
          onPrev={handlePrevPage}
          onNext={handleNextPage}
          isFetching={fila.isFetching}
          total={filaTotal}
          totalPages={filaTotalPages}
        />
      </>
    );
  }
}
