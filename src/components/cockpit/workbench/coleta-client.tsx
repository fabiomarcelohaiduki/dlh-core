"use client";

// =====================================================================
// ColetaClient — view de Coleta (Ingestao) sobre o WorkbenchTemplate.
//
// Submodulo Coleta com duas guias de topo mutuamente exclusivas (delta-31/32):
//   - "Execuções" (subpane coleta-execucoes): rodadas de coleta (RunsTable);
//   - "Dados"     (subpane coleta-dados):     itens capturados (DadosTable).
// Cada guia instancia seu proprio WorkbenchTemplate (escopo ingestao/coleta/*)
// com os blocos aplicaveis; so a guia ativa e montada. Acoes operacionais sao
// read-only (delta-28/29): clique abre o ActionModal e o lote dispara apenas o
// aviso "Apenas leitura", sem persistir efeito. EC-12 (lote) e EC-13 (item
// obsoleto) tratados aqui.
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { Subtabs } from "@/components/ui/subtabs";
import { Tabs } from "@/components/ui/tabs";
import { useExecucoes, useColetaDemanda } from "@/hooks/use-monitoring";
import { useExecucoesRealtime } from "@/hooks/use-execucoes-realtime";
import { useIngestaoConfig } from "@/hooks/use-fontes";
import { useDispararGmail, useDispararDrive } from "@/hooks/use-admin";
import { ApiError } from "@/lib/api/client";
import {
  execucaoDescriptor,
  normalizeOrigem,
  origemLabel,
  type OrigemKey,
  type PillState,
} from "@/lib/status";
import type { Execucao } from "@/lib/api/types";
import type {
  AgendamentosColetaData,
  EscopoColetaData,
} from "@/lib/fontes-credenciais-data";
import { WorkbenchTemplate } from "./workbench-template";
import { AgendamentoColeta } from "./agendamento-coleta";
import { EscopoColeta } from "./escopo-coleta";
import { RunsTable, RUNS_COLUMNS } from "./runs-table";
import { DadosTable, DADOS_COLUMNS, type DadoColetado } from "./dados-table";
import { RecursoFilter, type RecursoOption } from "./recurso-filter";
import { ActionModal, type ActionOption } from "./action-modal";
import {
  ColumnToggleMenu,
  FieldFilterMenu,
  TOOLBAR_SEARCH_CLASS,
} from "./table-toolbar-menus";
import { columnMeta, filterableMeta, matchFieldFilters } from "./table-column";
import { usePagination, TablePager, DEFAULT_PAGE_SIZE } from "./table-pagination";
import { CockpitToast } from "./cockpit-toast";
import type { WorkbenchScopeRef } from "./use-workbench-layout";

const RUNNING_POLL_MS = 3000;
const FALLBACK_POLL_MS = 5000;

type Subtab = "execucoes" | "dados" | "escopo" | "agendamento";
type FonteTab = "todas" | OrigemKey;

const FONTE_TABS: { value: FonteTab; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "effecti", label: "Effecti" },
  { value: "nomus", label: "Nomus" },
  { value: "gmail", label: "Gmail" },
  { value: "drive", label: "Drive" },
];

const RUN_ACTIONS: readonly ActionOption[] = [
  {
    id: "reexecutar",
    label: "Reexecutar agora",
    description: "Dispara novamente a coleta desta fonte.",
  },
  {
    id: "conferir",
    label: "Marcar como conferida",
    description: "Confirma a checagem desta execução.",
  },
  {
    id: "arquivar",
    label: "Arquivar",
    description: "Tira a execução da lista ativa.",
  },
];

const DADO_ACTIONS: readonly ActionOption[] = [
  {
    id: "abrir",
    label: "Abrir item",
    description: "Visualiza o documento ou registro capturado.",
  },
  {
    id: "reprocessar",
    label: "Reprocessar",
    description: "Reenvia o item para a fila de tratamento.",
  },
  {
    id: "arquivar",
    label: "Arquivar",
    description: "Tira o item da lista de coletados.",
  },
];

const EXECUCOES_BLOCKS = [
  "fontes",
  "recurso",
  "tempo-real",
  "busca",
  "filtros",
  "acao-principal",
  "acoes-linha",
] as const;

const DADOS_BLOCKS = ["fontes", "recurso", "busca", "filtros", "acoes-linha"] as const;

// Metadados das colunas para os menus icon-only da toolbar (visibilidade e
// filtro por campo). Derivados das mesmas listas que as tabelas renderizam.
const RUNS_COL_META = columnMeta(RUNS_COLUMNS);
const RUNS_FILTER_META = filterableMeta(RUNS_COLUMNS);
const DADOS_COL_META = columnMeta(DADOS_COLUMNS);
const DADOS_FILTER_META = filterableMeta(DADOS_COLUMNS);

const EXECUCOES_SCOPE: WorkbenchScopeRef = {
  modulo: "ingestao",
  tela: "coleta",
  guia: "execucoes",
};
const DADOS_SCOPE: WorkbenchScopeRef = {
  modulo: "ingestao",
  tela: "coleta",
  guia: "dados",
};

/** Status do dado coletado (projecao read-only do status da execucao). */
function dadoStatus(run: Execucao): { state: PillState; label: string } {
  switch (run.status) {
    case "em_andamento":
      return { state: "run", label: "Importando" };
    case "erro":
      return { state: "err", label: "Erro" };
    case "concluida":
      return { state: "ok", label: "Importado" };
    default:
      return { state: "idle", label: "Novo" };
  }
}

/** Modal aberto (execucao ou dado). */
type ModalState =
  | { kind: "run"; id: string; title: string }
  | { kind: "dado"; id: string; title: string }
  | null;

type Toast = { message: string } | null;

export function ColetaClient({
  agendamentos,
  escopo,
}: {
  agendamentos: AgendamentosColetaData;
  escopo: EscopoColetaData;
}) {
  const [subtab, setSubtab] = useState<Subtab>("execucoes");

  // Quantas fontes tem a coleta automatica ligada (badge da guia Agendamento).
  const agendamentosAtivos = [
    agendamentos.effecti,
    agendamentos.nomusProcessos,
    agendamentos.nomusPessoas,
    agendamentos.gmail,
    agendamentos.drive,
  ].filter((a) => a.ativo).length;

  // Filtros da guia Execuções (recurso = sub-filtro single-select da fonte).
  const [fonte, setFonte] = useState<FonteTab>("todas");
  const [recurso, setRecurso] = useState("todos");
  const [busca, setBusca] = useState("");

  // Filtros da guia Dados.
  const [dFonte, setDFonte] = useState<FonteTab>("todas");
  const [dRecurso, setDRecurso] = useState("todos");
  const [dBusca, setDBusca] = useState("");

  // Trocar de fonte zera o recurso (single-select por fonte, igual protótipo).
  const handleFonteChange = (next: FonteTab) => {
    setFonte(next);
    setRecurso("todos");
  };
  const handleDFonteChange = (next: FonteTab) => {
    setDFonte(next);
    setDRecurso("todos");
  };

  // Colunas ocultas + filtros por campo (controles icon-only da toolbar).
  const [runsHidden, setRunsHidden] = useState<Set<string>>(() => new Set());
  const [runsFieldFilters, setRunsFieldFilters] = useState<Record<string, string>>(
    {},
  );
  const [dadosHidden, setDadosHidden] = useState<Set<string>>(() => new Set());
  const [dadosFieldFilters, setDadosFieldFilters] = useState<
    Record<string, string>
  >({});

  const toggleHidden = (set: typeof setRunsHidden) => (id: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<Toast>(null);

  // Disparo manual da coleta por fonte. Sem GitHub Actions (desativado 28/06):
  // a coleta roda so em Supabase Edge (Effecti, Gmail, Drive) e no PC local
  // (Nomus). Effecti/Gmail/Drive disparam a Edge nativa do Supabase. Nomus NAO
  // tem disparo pelo cockpit: roda so no PC local (Agendador do Windows), pois
  // o TLS CBC legado nao conecta da Edge e nao ha canal cockpit -> PC.
  const coletaEffecti = useColetaDemanda();
  const coletaGmail = useDispararGmail();
  const coletaDrive = useDispararDrive();
  const coletando =
    coletaEffecti.isPending || coletaGmail.isPending || coletaDrive.isPending;

  // Recursos ativos do Nomus (so quando a fonte selecionada e Nomus): alimentam
  // o seletor de recurso com pessoas/processos mesmo sem execucao previa.
  const nomusConfig = useIngestaoConfig("nomus", { enabled: fonte === "nomus" });

  const { connected } = useExecucoesRealtime();
  const execucoes = useExecucoes({
    limit: 50,
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      if (items.some((r) => r.status === "em_andamento")) return RUNNING_POLL_MS;
      return connected ? false : FALLBACK_POLL_MS;
    },
  });

  const allRuns = useMemo(() => execucoes.data?.items ?? [], [execucoes.data]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // Recursos da fonte selecionada (Execuções), derivados do dado real.
  const recursoOptions = useMemo<RecursoOption[]>(() => {
    if (fonte === "todas") return [];
    const counts = new Map<string, number>();
    for (const r of allRuns) {
      if (normalizeOrigem(r.origem) !== fonte || !r.recurso) continue;
      counts.set(r.recurso, (counts.get(r.recurso) ?? 0) + 1);
    }
    // Nomus: garante os recursos ATIVOS na config no seletor, mesmo sem execucao
    // previa (senao pessoas nunca apareceria para o primeiro disparo manual).
    if (fonte === "nomus" && nomusConfig.data) {
      for (const [key, cfg] of Object.entries(nomusConfig.data.recursos)) {
        if (cfg.ativo && !counts.has(key)) counts.set(key, 0);
      }
    }
    return [...counts.entries()].map(([value, count]) => ({
      value,
      label: value,
      count,
    }));
  }, [allRuns, fonte, nomusConfig.data]);

  const recursoTotal = useMemo(
    () =>
      fonte === "todas"
        ? 0
        : allRuns.filter((r) => normalizeOrigem(r.origem) === fonte).length,
    [allRuns, fonte],
  );

  // ---- Execuções: filtro client-side ----
  const runs = useMemo(
    () =>
      allRuns.filter((r) => {
        if (fonte !== "todas" && normalizeOrigem(r.origem) !== fonte) return false;
        if (recurso !== "todos" && (r.recurso ?? "") !== recurso) return false;
        if (busca.trim()) {
          const q = busca.trim().toLowerCase();
          const hay = `${origemLabel(normalizeOrigem(r.origem))} ${r.recurso ?? ""} ${r.gatilho ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (!matchFieldFilters(r, RUNS_COLUMNS, runsFieldFilters)) return false;
        return true;
      }),
    [allRuns, fonte, recurso, busca, runsFieldFilters],
  );

  // ---- Dados: projecao honesta das execucoes ----
  const allDados = useMemo<DadoColetado[]>(
    () =>
      allRuns.map((r) => {
        const origemKey = normalizeOrigem(r.origem);
        const origem = origemLabel(origemKey);
        return {
          id: r.id,
          titulo: `Coleta ${origem}${r.recurso ? ` · ${r.recurso}` : ""}`,
          origem,
          origemKey,
          recurso: r.recurso,
          captadoEm: r.fim ?? r.inicio,
          itens: String(r.novos + r.alterados),
          status: dadoStatus(r),
        };
      }),
    [allRuns],
  );

  // Recursos da fonte selecionada (Dados), derivados do dado real.
  const dRecursoOptions = useMemo<RecursoOption[]>(() => {
    if (dFonte === "todas") return [];
    const counts = new Map<string, number>();
    for (const d of allDados) {
      if (d.origemKey !== dFonte || !d.recurso) continue;
      counts.set(d.recurso, (counts.get(d.recurso) ?? 0) + 1);
    }
    return [...counts.entries()].map(([value, count]) => ({
      value,
      label: value,
      count,
    }));
  }, [allDados, dFonte]);

  const dRecursoTotal = useMemo(
    () =>
      dFonte === "todas"
        ? 0
        : allDados.filter((d) => d.origemKey === dFonte).length,
    [allDados, dFonte],
  );

  const dados = useMemo(
    () =>
      allDados.filter((d) => {
        if (dFonte !== "todas" && d.origemKey !== dFonte) return false;
        if (dRecurso !== "todos" && (d.recurso ?? "") !== dRecurso) return false;
        if (dBusca.trim()) {
          const q = dBusca.trim().toLowerCase();
          const hay = `${d.titulo} ${d.recurso ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (!matchFieldFilters(d, DADOS_COLUMNS, dadosFieldFilters)) return false;
        return true;
      }),
    [allDados, dFonte, dRecurso, dBusca, dadosFieldFilters],
  );

  // Paginacao client-side (25 por pagina) sobre as listas ja filtradas. O
  // resetKey volta a pagina 1 sempre que o criterio de filtro muda.
  const runsPage = usePagination(
    runs,
    DEFAULT_PAGE_SIZE,
    `${fonte}|${recurso}|${busca}|${JSON.stringify(runsFieldFilters)}`,
  );
  const dadosPage = usePagination(
    dados,
    DEFAULT_PAGE_SIZE,
    `${dFonte}|${dRecurso}|${dBusca}|${JSON.stringify(dadosFieldFilters)}`,
  );

  // Contagem por fonte (badge das guias do topo), sobre o universo carregado.
  const fonteCount = (tab: FonteTab, raw: Execucao[]) =>
    tab === "todas"
      ? raw.length
      : raw.filter((r) => normalizeOrigem(r.origem) === tab).length;

  // Contagem por fonte para a guia Dados (universo da propria guia).
  const dadoFonteCount = (tab: FonteTab) =>
    tab === "todas"
      ? allDados.length
      : allDados.filter((d) => d.origemKey === tab).length;

  // EC-13: item obsoleto quando saiu da lista entre o clique e a abertura.
  const modalObsolete = useMemo(() => {
    if (!modal) return false;
    return !allRuns.some((r) => r.id === modal.id);
  }, [modal, allRuns]);

  function handleReadOnly(message: string) {
    setToast({ message });
  }

  // Botao "Coletar agora": dispara a coleta da fonte selecionada. Com "Todas"
  // ativa nao ha fonte alvo, entao orienta escolher uma (cada fonte tem seu
  // proprio disparo). O 409 do backend = single-flight (ja ha coleta rodando).
  async function handleColetarAgora() {
    if (fonte === "todas") {
      setToast({
        message: "Selecione uma fonte (Effecti, Nomus, Gmail ou Drive) para coletar.",
      });
      return;
    }
    if (fonte === "nomus") {
      // Nomus roda so no PC local (Agendador do Windows): sem GitHub Actions e
      // sem canal cockpit -> PC, nao ha disparo manual daqui. Avisa e nao tenta.
      setToast({
        message:
          "Nomus é coletado no PC local (Agendador do Windows). Não há disparo manual pelo cockpit.",
      });
      return;
    }
    if (coletando) return;
    try {
      if (fonte === "effecti") await coletaEffecti.mutateAsync(undefined);
      else if (fonte === "gmail") await coletaGmail.mutateAsync();
      else await coletaDrive.mutateAsync();
      setToast({
        message: `Coleta ${origemLabel(fonte)} disparada · acompanhe nas execuções.`,
      });
    } catch (err) {
      setToast({
        message:
          err instanceof ApiError && err.status === 409
            ? "Já existe uma coleta em andamento; aguarde a conclusão."
            : "Não foi possível disparar a coleta. Tente novamente.",
      });
    }
  }

  return (
    <>
      <Subtabs<Subtab>
        ariaLabel="Guias do submódulo Coleta"
        value={subtab}
        onValueChange={setSubtab}
        items={[
          { value: "execucoes", label: "Execuções", count: allRuns.length },
          { value: "dados", label: "Dados", count: allDados.length },
          { value: "escopo", label: "Escopo" },
          { value: "agendamento", label: "Agendamento", count: agendamentosAtivos },
        ]}
      />

      {subtab === "execucoes" && (
        <div data-subpane="coleta-execucoes" data-scope="ingestao/coleta/execucoes">
          <WorkbenchTemplate
            scope={EXECUCOES_SCOPE}
            workbenchKey="coleta"
            actionLabel={
              coletando
                ? "Disparando…"
                : fonte === "todas"
                  ? "Coletar agora"
                  : `Coletar ${origemLabel(fonte)}`
            }
            onAction={handleColetarAgora}
            actionDisabled={coletando}
            actionTitle={
              fonte === "todas"
                ? "Selecione uma fonte para coletar"
                : fonte === "nomus"
                  ? "Nomus é coletado no PC local (sem disparo pelo cockpit)"
                  : `Disparar coleta ${origemLabel(fonte)}`
            }
            toastClassName="bottom-[5.5rem]"
            blocks={EXECUCOES_BLOCKS}
            slots={{
              fontes: (
                <Tabs<FonteTab>
                  ariaLabel="Filtrar execuções por fonte"
                  className="border-b-0 px-0"
                  value={fonte}
                  onValueChange={handleFonteChange}
                  items={FONTE_TABS.map((t) => ({
                    value: t.value,
                    label: t.label,
                    count: fonteCount(t.value, allRuns),
                  }))}
                />
              ),
              recurso:
                recursoOptions.length > 0 ? (
                  <RecursoFilter
                    ariaLabel="Filtrar execuções por recurso da fonte"
                    options={recursoOptions}
                    total={recursoTotal}
                    value={recurso}
                    onValueChange={setRecurso}
                  />
                ) : null,
              busca: (
                <input
                  type="search"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder="Buscar por origem, recurso ou gatilho"
                  aria-label="Buscar execuções de coleta"
                  className={TOOLBAR_SEARCH_CLASS}
                />
              ),
              filtros: (
                <span className="flex items-center gap-2.5">
                  <FieldFilterMenu
                    columns={RUNS_FILTER_META}
                    values={runsFieldFilters}
                    onChange={(id, value) =>
                      setRunsFieldFilters((p) => ({ ...p, [id]: value }))
                    }
                    onClear={() => setRunsFieldFilters({})}
                  />
                  <ColumnToggleMenu
                    columns={RUNS_COL_META}
                    hidden={runsHidden}
                    onToggle={toggleHidden(setRunsHidden)}
                    onShowAll={() => setRunsHidden(new Set())}
                  />
                </span>
              ),
            }}
          >
            <RunsTable
              runs={runsPage.pageItems}
              loading={execucoes.isLoading}
              error={execucoes.isError}
              onRetry={() => execucoes.refetch()}
              hidden={runsHidden}
              onItemClick={(run) =>
                setModal({
                  kind: "run",
                  id: run.id,
                  title: `Execução · ${execucaoDescriptor(run).label}`,
                })
              }
              emptyTitle={
                fonte !== "todas" ||
                busca.trim() ||
                Object.values(runsFieldFilters).some((v) => v.trim())
                  ? "Nenhuma execução para o filtro"
                  : "Nenhuma execução nesta guia"
              }
              emptyDescription={
                fonte !== "todas" ||
                busca.trim() ||
                Object.values(runsFieldFilters).some((v) => v.trim())
                  ? "Ajuste a busca, o filtro ou a fonte para ver outras execuções."
                  : "Ainda não há coletas registradas. Use “Coletar agora” para gerar uma execução."
              }
            />
            <TablePager {...runsPage} />
          </WorkbenchTemplate>
        </div>
      )}

      {subtab === "dados" && (
        <div data-subpane="coleta-dados" data-scope="ingestao/coleta/dados">
          <WorkbenchTemplate
            scope={DADOS_SCOPE}
            workbenchKey="coleta-dados"
            toastClassName="bottom-[5.5rem]"
            blocks={DADOS_BLOCKS}
            slots={{
              fontes: (
                <Tabs<FonteTab>
                  ariaLabel="Filtrar dados por fonte"
                  className="border-b-0 px-0"
                  value={dFonte}
                  onValueChange={handleDFonteChange}
                  items={FONTE_TABS.map((t) => ({
                    value: t.value,
                    label: t.label,
                    count: dadoFonteCount(t.value),
                  }))}
                />
              ),
              recurso:
                dRecursoOptions.length > 0 ? (
                  <RecursoFilter
                    ariaLabel="Filtrar dados por recurso da fonte"
                    options={dRecursoOptions}
                    total={dRecursoTotal}
                    value={dRecurso}
                    onValueChange={setDRecurso}
                  />
                ) : null,
              busca: (
                <input
                  type="search"
                  value={dBusca}
                  onChange={(e) => setDBusca(e.target.value)}
                  placeholder="Buscar por título, recurso ou tipo"
                  aria-label="Buscar dados coletados"
                  className={TOOLBAR_SEARCH_CLASS}
                />
              ),
              filtros: (
                <span className="flex items-center gap-2.5">
                  <FieldFilterMenu
                    columns={DADOS_FILTER_META}
                    values={dadosFieldFilters}
                    onChange={(id, value) =>
                      setDadosFieldFilters((p) => ({ ...p, [id]: value }))
                    }
                    onClear={() => setDadosFieldFilters({})}
                  />
                  <ColumnToggleMenu
                    columns={DADOS_COL_META}
                    hidden={dadosHidden}
                    onToggle={toggleHidden(setDadosHidden)}
                    onShowAll={() => setDadosHidden(new Set())}
                  />
                </span>
              ),
            }}
          >
            <DadosTable
              dados={dadosPage.pageItems}
              loading={execucoes.isLoading}
              error={execucoes.isError}
              onRetry={() => execucoes.refetch()}
              hidden={dadosHidden}
              onItemClick={(d) =>
                setModal({ kind: "dado", id: d.id, title: d.titulo })
              }
              emptyTitle={
                dFonte !== "todas" ||
                dBusca.trim() ||
                Object.values(dadosFieldFilters).some((v) => v.trim())
                  ? "Nenhum item para o filtro"
                  : "Nenhum item nesta guia"
              }
              emptyDescription={
                dFonte !== "todas" ||
                dBusca.trim() ||
                Object.values(dadosFieldFilters).some((v) => v.trim())
                  ? "Ajuste a busca ou o filtro para ver os dados coletados."
                  : "Ainda não há itens capturados. Dispare uma coleta para começar a trazer dados."
              }
            />
            <TablePager {...dadosPage} />
          </WorkbenchTemplate>
        </div>
      )}

      {subtab === "escopo" && (
        <div data-subpane="coleta-escopo" data-scope="ingestao/coleta/escopo">
          <EscopoColeta {...escopo} />
        </div>
      )}

      {subtab === "agendamento" && (
        <div data-subpane="coleta-agendamento" data-scope="ingestao/coleta/agendamento">
          <AgendamentoColeta {...agendamentos} />
        </div>
      )}

      <ActionModal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal?.title ?? "Ações"}
        description={modalObsolete ? undefined : "Escolha uma ação para este item."}
        obsolete={modalObsolete}
        options={modal?.kind === "dado" ? DADO_ACTIONS : RUN_ACTIONS}
        onAction={() => {
          setModal(null);
          handleReadOnly("Apenas leitura — nenhuma ação foi executada.");
        }}
      />

      {toast ? <CockpitToast kind="info" message={toast.message} /> : null}
    </>
  );
}
