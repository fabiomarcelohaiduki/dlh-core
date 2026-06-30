"use client";

// =====================================================================
// IndexacaoView — guia "Indexação" do submódulo Coleta.
//
// Mostra, 1 linha por REGISTRO, o status consolidado de indexação (embeddings)
// unindo o CORPO (avisos Effecti / descrição Nomus) com os ANEXOS extraídos
// (documentos). Um registro só fica "Indexado" quando TUDO que é indexável
// nele já virou embedding. Roda sobre o WorkbenchTemplate com leitura PAGINADA
// server-side por keyset (recall total), espelhando a guia "Fila de extração".
//
//   - Tabs de fonte (Todas/Effecti/Nomus/Gmail/Drive): filtra a tabela.
//   - 6 cards de status (StatCard): clicar filtra a tabela pelo status. O 4º,
//     "Aguardando extração", é honesto: um anexo que ainda não virou texto NÃO
//     aparece como pendente de indexação — aponta a etapa anterior (Tika/OCR).
//   - Ação GLOBAL no header: "Indexar agora" (1 lote de backfill auto-encadeado,
//     reusa o disparo existente). Só gasta com o interruptor LIGADO (aba
//     Agendamento); desligado, o botão fica inerte e explica o porquê.
//   - Ação contextual (card Erros): "Reprocessar erros" devolve os registros em
//     erro para a fila de indexação, respeitando o filtro de fonte.
//   - Botão "Parâmetros" abre o drawer com a Config da camada de embeddings.
//
// As mutações (disparar/reprocessar) invalidam a lista mestra
// (indexacaoRegistrosKeys.all) pelos próprios hooks, refletindo na hora.
// =====================================================================

import { type CSSProperties, Fragment, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  EyeOff,
  Loader2,
  RotateCcw,
  ScanText,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { StatCard } from "@/components/cockpit/stat-card";
import { StatusPill } from "@/components/cockpit/status-pill";
import { IndexacaoConfigForm } from "@/components/cockpit/indexacao-config-form";
import {
  useDispararIndexacao,
  useReprocessarErrosIndexacao,
} from "@/hooks/use-indexacao";
import { useIndexacaoRegistros } from "@/hooks/use-indexacao-registros";
import type {
  IndexacaoRegistroCursor,
  IndexacaoRegistroItem,
  IndexacaoStatusConsolidado,
} from "@/lib/api/indexacao";
import type { ConfigIndexacaoState, FonteIndexacao } from "@/lib/api/types";
import { ApiError } from "@/lib/api/client";
import { indexacaoConsolidadoDescriptor } from "@/lib/status";
import { formatNumber } from "@/lib/format";
import type { WorkbenchScopeRef } from "./use-workbench-layout";
import { WorkbenchTemplate } from "./workbench-template";
import { TOOLBAR_SEARCH_CLASS } from "./table-toolbar-menus";
import { splitDateTime } from "./table-states";
import { CursorPager } from "./table-pagination";
import { CockpitToast } from "./cockpit-toast";
import { IndexacaoRegistroDetalhe } from "./indexacao-registro-detalhe";

/** id do painel de detalhe (alvo do aria-controls do expansor). */
function panelIdFor(idComposto: string): string {
  return `indexacao-detalhe-${idComposto.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

type FonteTab = "todas" | FonteIndexacao;

const FONTE_TABS: { value: FonteTab; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "effecti", label: "Effecti" },
  { value: "nomus", label: "Nomus" },
  { value: "gmail", label: "Gmail" },
  { value: "drive", label: "Drive" },
];

const FONTE_LABEL: Record<FonteIndexacao, string> = {
  effecti: "Effecti",
  nomus: "Nomus",
  gmail: "Gmail",
  drive: "Drive",
};

const STATUS_LABEL: Record<IndexacaoStatusConsolidado, string> = {
  indexado: "Indexados",
  pendente: "Pendentes",
  indexando: "Indexando",
  aguardando_extracao: "Aguardando extração",
  erro: "Erros",
  sem_conteudo: "Sem conteúdo",
};

const IX_BLOCKS = ["fontes", "busca", "filtros", "acao-principal"] as const;

const IX_SCOPE: WorkbenchScopeRef = {
  modulo: "ingestao",
  tela: "coleta",
  guia: "indexacao",
};

const PAGE_SIZE = 50;

type Toast = { kind: "ok" | "err" | "info"; message: string } | null;

export function IndexacaoView({
  configIndexacao,
}: {
  configIndexacao: ConfigIndexacaoState;
}) {
  // Filtros (server-side): fonte das Tabs, status dos cards, busca textual.
  const [fonte, setFonte] = useState<FonteTab>("todas");
  const [status, setStatus] = useState<IndexacaoStatusConsolidado>("pendente");
  const [busca, setBusca] = useState("");

  // Paginação por cursor server-side: pilha de cursores; avançar empilha o
  // atual, voltar desempilha.
  const [cursors, setCursors] = useState<readonly (IndexacaoRegistroCursor | null)[]>([]);
  const [currentCursor, setCurrentCursor] = useState<IndexacaoRegistroCursor | null>(null);

  // Confirmação inline (2 cliques, modelo SOM) do disparo global de indexação.
  const [confirmIndexar, setConfirmIndexar] = useState(false);

  // Linhas expandidas (mestre-detalhe): drill-down do X/Y de anexos. Vários
  // registros podem estar abertos ao mesmo tempo (igual à guia Dados).
  const [expandido, setExpandido] = useState<ReadonlySet<string>>(new Set());

  // Drawer de parâmetros (Config da camada de embeddings).
  const [paramsAberto, setParamsAberto] = useState(false);
  const paramsTriggerRef = useRef<HTMLButtonElement>(null);

  const [toast, setToast] = useState<Toast>(null);

  const alvoFonte: FonteIndexacao | undefined = fonte === "todas" ? undefined : fonte;

  const disparar = useDispararIndexacao();
  const reprocessar = useReprocessarErrosIndexacao(alvoFonte ? [alvoFonte] : null);

  const registros = useIndexacaoRegistros({
    fonte: fonte === "todas" ? null : fonte,
    status,
    busca: busca.trim() || null,
    cursor: currentCursor,
    limit: PAGE_SIZE,
  });

  const itens = registros.data?.itens ?? [];
  const nextCursor = registros.data?.nextCursor ?? null;
  const contagens = registros.data?.contagens;
  const pageNumber = cursors.length + 1;

  // Trocar fonte/status/busca zera o cursor, a confirmação e as expansões.
  useEffect(() => {
    setCursors([]);
    setCurrentCursor(null);
    setConfirmIndexar(false);
    setExpandido(new Set());
  }, [fonte, status, busca]);

  // Abre/fecha o detalhe de um registro (toggle no conjunto expandido).
  function toggleExpandido(idComposto: string) {
    setExpandido((prev) => {
      const next = new Set(prev);
      if (next.has(idComposto)) next.delete(idComposto);
      else next.add(idComposto);
      return next;
    });
  }

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // A confirmação de disparo expira sozinha (não deixa o botão "armado").
  useEffect(() => {
    if (!confirmIndexar) return;
    const t = setTimeout(() => setConfirmIndexar(false), 4000);
    return () => clearTimeout(t);
  }, [confirmIndexar]);

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
  function selecionarStatus(s: IndexacaoStatusConsolidado) {
    setStatus(s);
    setFonte("todas");
  }

  // ---- Disparo GLOBAL "Indexar agora" (header). 1 lote de backfill
  // auto-encadeado; só gasta com o interruptor de documentos LIGADO. Gate de
  // confirmação em 2 cliques (modelo SOM).
  const ligado = configIndexacao.ativo;
  const disparando = disparar.isPending;
  const indexarLabel = disparando
    ? "Disparando…"
    : !ligado
      ? "Ligue a indexação"
      : confirmIndexar
        ? "Confirmar · Indexar agora"
        : "Indexar agora";
  const indexarDisabled = !ligado || disparando;
  const indexarTitle = !ligado
    ? "Ligue o interruptor da indexação na aba Agendamento antes de disparar"
    : "Processa um lote do acervo parado (auto-encadeado até esgotar a fila)";

  async function handleIndexar() {
    if (indexarDisabled) return;
    if (!confirmIndexar) {
      setConfirmIndexar(true);
      return;
    }
    setConfirmIndexar(false);
    try {
      await disparar.mutateAsync();
      setToast({ kind: "ok", message: "Indexação disparada · processa o acervo parado em lotes." });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? "Já há uma indexação em andamento; aguarde a conclusão."
          : "Não foi possível disparar a indexação. Tente novamente.";
      setToast({ kind: "err", message });
    }
  }

  // ---- Ação contextual (card Erros): devolve os registros em erro para a fila.
  async function handleReprocessar() {
    if (reprocessar.isPending || status !== "erro") return;
    try {
      const r = await reprocessar.mutateAsync();
      setToast({
        kind: "ok",
        message:
          r.reenfileirados > 0
            ? `${formatNumber(r.reenfileirados)} registro(s) voltaram para a fila de indexação.`
            : "Nenhum registro em erro para reprocessar.",
      });
    } catch {
      setToast({ kind: "err", message: "Não foi possível reprocessar. Tente novamente." });
    }
  }

  const statusCount = (s: IndexacaoStatusConsolidado): number => contagens?.porStatus[s] ?? 0;
  const fonteCount = (t: FonteTab): number =>
    t === "todas" ? contagens?.total ?? 0 : contagens?.porFonte[t] ?? 0;

  // Total honesto p/ o rodapé: com fonte específica OU busca ativa, a
  // interseção fonte×status não é conhecida -> "Página X". Caso contrário, é
  // porStatus[status].
  const ixTotal = busca.trim() || fonte !== "todas" ? undefined : statusCount(status);
  const ixTotalPages =
    ixTotal && ixTotal > 0 ? Math.max(1, Math.ceil(ixTotal / PAGE_SIZE)) : undefined;

  const capStyle: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: "var(--faint)" };

  return (
    <>
      <WorkbenchTemplate
        scope={IX_SCOPE}
        workbenchKey="coleta-indexacao"
        toastClassName="bottom-[5.5rem]"
        blocks={IX_BLOCKS}
        actionLabel={indexarLabel}
        onAction={handleIndexar}
        actionDisabled={indexarDisabled}
        actionTitle={indexarTitle}
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
              ariaLabel="Filtrar a indexação por fonte"
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
              placeholder="Buscar por nome do registro"
              aria-label="Buscar registros na indexação"
              className={TOOLBAR_SEARCH_CLASS}
            />
          ),
          filtros: renderAcaoContextual(),
        }}
      >
        {renderTabela()}
      </WorkbenchTemplate>

      {paramsAberto ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Parâmetros de indexação"
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
              <h3>Parâmetros de indexação</h3>
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
              <IndexacaoConfigForm initial={configIndexacao} />
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <CockpitToast kind={toast.kind} message={toast.message} className="bottom-[5.5rem]" /> : null}
    </>
  );

  // ------------------------------------------------------------------
  // Cards de status (banner do card, abaixo do cabeçalho). Grid de 6 colunas.
  // ------------------------------------------------------------------
  function renderCards() {
    return (
      <div className="grid-dlh g6">
        <StatCard
          icon={<Check aria-hidden="true" />}
          label="Indexados"
          loading={registros.isLoading}
          value={<span className="tnum" style={{ color: "var(--ok)" }}>{formatNumber(statusCount("indexado"))}</span>}
          meta="embeddings prontos"
          metaTone="up"
          onClick={() => selecionarStatus("indexado")}
          active={status === "indexado"}
        />
        <StatCard
          icon={<Clock aria-hidden="true" />}
          label="Pendentes"
          loading={registros.isLoading}
          value={<span className="tnum" style={{ color: statusCount("pendente") > 0 ? "var(--run)" : undefined }}>{formatNumber(statusCount("pendente"))}</span>}
          meta="aguardando indexação"
          onClick={() => selecionarStatus("pendente")}
          active={status === "pendente"}
        />
        <StatCard
          icon={<Loader2 aria-hidden="true" />}
          label="Indexando"
          loading={registros.isLoading}
          value={<span className="tnum" style={{ color: statusCount("indexando") > 0 ? "var(--run)" : undefined }}>{formatNumber(statusCount("indexando"))}</span>}
          meta="gerando embeddings"
          onClick={() => selecionarStatus("indexando")}
          active={status === "indexando"}
        />
        <StatCard
          icon={<ScanText aria-hidden="true" />}
          label="Aguardando extração"
          loading={registros.isLoading}
          value={<span className="tnum" style={{ color: statusCount("aguardando_extracao") > 0 ? "var(--warn)" : undefined }}>{formatNumber(statusCount("aguardando_extracao"))}</span>}
          meta="texto ainda não extraído (Tika/OCR)"
          onClick={() => selecionarStatus("aguardando_extracao")}
          active={status === "aguardando_extracao"}
        />
        <StatCard
          icon={<TriangleAlert aria-hidden="true" />}
          label="Erros"
          loading={registros.isLoading}
          value={<span className="tnum" style={{ color: statusCount("erro") > 0 ? "var(--err)" : undefined }}>{formatNumber(statusCount("erro"))}</span>}
          meta={statusCount("erro") > 0 ? "clique para ver a lista" : "sem falhas"}
          metaTone={statusCount("erro") > 0 ? "warn" : "up"}
          onClick={() => selecionarStatus("erro")}
          active={status === "erro"}
        />
        <StatCard
          icon={<EyeOff aria-hidden="true" />}
          label="Sem conteúdo"
          loading={registros.isLoading}
          value={<span className="tnum">{formatNumber(statusCount("sem_conteudo"))}</span>}
          meta="nada indexável no registro"
          onClick={() => selecionarStatus("sem_conteudo")}
          active={status === "sem_conteudo"}
        />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Ação contextual ao card selecionado (slot filtros): só o card Erros tem
  // ação — "Reprocessar erros", respeitando o filtro de fonte.
  // ------------------------------------------------------------------
  function renderAcaoContextual() {
    if (status !== "erro" || statusCount("erro") === 0) return null;
    return (
      <span className="ml-auto inline-flex items-center gap-2.5">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={handleReprocessar}
          disabled={reprocessar.isPending}
          aria-disabled={reprocessar.isPending}
          title={
            fonte === "todas"
              ? "Volta os registros em erro para a fila de indexação"
              : `Volta os registros em erro do ${FONTE_LABEL[fonte]} para a fila`
          }
        >
          {reprocessar.isPending ? <Loader2 className="spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
          <span>{reprocessar.isPending ? "Reprocessando…" : fonte === "todas" ? "Reprocessar erros" : `Reprocessar erros · ${FONTE_LABEL[fonte]}`}</span>
        </button>
      </span>
    );
  }

  // ------------------------------------------------------------------
  // Tabela paginada + rodapé CursorPager.
  // ------------------------------------------------------------------
  function renderTabela() {
    return (
      <>
        <div className="tbl-wrap tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>Registro</th>
                <th>Fonte</th>
                <th>Corpo</th>
                <th>Anexos</th>
                <th>Status</th>
                <th>Quando</th>
              </tr>
            </thead>
            <tbody>
              {registros.isLoading ? (
                Array.from({ length: 4 }).map((_, r) => (
                  <tr key={r}>
                    {Array.from({ length: 6 }).map((__, c) => (
                      <td key={c}>
                        <span className="skel skel-line" style={{ width: `${40 + ((r + c) % 4) * 14}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : registros.isError ? (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">
                      <TriangleAlert aria-hidden="true" />
                      <h4>Não foi possível carregar a indexação</h4>
                      <p>
                        <button type="button" className="btn btn-sm" onClick={() => registros.refetch()}>
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
                      <h4>Nenhum registro em {STATUS_LABEL[status].toLowerCase()}</h4>
                      <p style={capStyle}>
                        {fonte === "todas" && !busca.trim()
                          ? "Nada para mostrar neste status."
                          : "Nada para mostrar neste status com o filtro atual."}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                itens.map((item) => renderLinha(item))
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
          isFetching={registros.isFetching}
          total={ixTotal}
          totalPages={ixTotalPages}
        />
      </>
    );
  }

  // ------------------------------------------------------------------
  // Linha mestra (registro) + linha-irmã de detalhe quando expandida. A célula
  // "Registro" ganha o expansor (chevron) e, abaixo do título, o ID de origem
  // quando ele difere do título (ex.: Effecti -> objeto + effecti_id).
  // ------------------------------------------------------------------
  function renderLinha(item: IndexacaoRegistroItem) {
    const descriptor = indexacaoConsolidadoDescriptor(item.status);
    const temAnexo = item.anexosIndexavel > 0;
    const aberto = expandido.has(item.idComposto);
    const panelId = panelIdFor(item.idComposto);
    const mostrarId = item.registroOrigemId !== item.tituloCurto;
    const { data: quandoData, hora: quandoHora } = splitDateTime(item.captadoEm);

    return (
      <Fragment key={item.idComposto}>
        <tr>
          <td className="cell-arquivo">
            <span className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-sm btn-icon"
                aria-expanded={aberto}
                aria-controls={panelId}
                aria-label={aberto ? `Recolher ${item.tituloCurto}` : `Expandir ${item.tituloCurto}`}
                onClick={() => toggleExpandido(item.idComposto)}
              >
                {aberto ? (
                  <ChevronDown aria-hidden="true" />
                ) : (
                  <ChevronRight aria-hidden="true" />
                )}
              </button>
              <span className="flex min-w-0 flex-col">
                <span className="trunc" title={item.tituloCurto}>{item.tituloCurto}</span>
                {mostrarId ? (
                  <span className="sub trunc" title={item.registroOrigemId}>{item.registroOrigemId}</span>
                ) : null}
              </span>
            </span>
          </td>
          <td>
            <span className="pill src">{FONTE_LABEL[item.fonte] ?? item.fonte}</span>
          </td>
          <td className="sub">{item.corpoStatus ?? "—"}</td>
          <td className="sub tnum">
            {temAnexo ? `${formatNumber(item.anexosIndexados)}/${formatNumber(item.anexosIndexavel)}` : "—"}
          </td>
          <td>
            <StatusPill state={descriptor.state} label={descriptor.label} />
          </td>
          <td className="tnum">
            <span className="flex flex-col leading-tight">
              <strong>{quandoData}</strong>
              {quandoHora ? <span className="sub">{quandoHora}</span> : null}
            </span>
          </td>
        </tr>
        {aberto ? <IndexacaoRegistroDetalhe item={item} panelId={panelId} /> : null}
      </Fragment>
    );
  }
}
