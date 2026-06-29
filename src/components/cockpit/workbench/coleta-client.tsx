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
import { X } from "lucide-react";
import { Subtabs } from "@/components/ui/subtabs";
import { Tabs } from "@/components/ui/tabs";
import { useExecucoes, useColetaDemanda } from "@/hooks/use-monitoring";
import { useExecucoesRealtime } from "@/hooks/use-execucoes-realtime";
import { useIngestaoConfig } from "@/hooks/use-fontes";
import { useDispararGmail, useDispararDrive } from "@/hooks/use-admin";
import { useEnfileirarComandoLocal } from "@/hooks/use-comando-local";
import type { ComandoLocalTipo } from "@/lib/api/comando-local";
import { ApiError } from "@/lib/api/client";
import {
  normalizeOrigem,
  origemLabel,
  type OrigemKey,
} from "@/lib/status";
import type { Execucao } from "@/lib/api/types";
import type { ColetaLogOrigem } from "@/lib/api/coleta-log";
import type {
  AgendamentosColetaData,
  EscopoColetaData,
} from "@/lib/fontes-credenciais-data";
import { WorkbenchTemplate } from "./workbench-template";
import { AgendamentoColeta } from "./agendamento-coleta";
import { EscopoColeta } from "./escopo-coleta";
import { LogsConsole } from "./logs-console";
import {
  RunsTable,
  RUNS_COLUMNS,
  horarioAgendadoDaFonte,
  type RunComAgenda,
} from "./runs-table";
import { formatDateTime } from "./table-states";
import { RecursoFilter, type RecursoOption } from "./recurso-filter";
import {
  ColumnToggleMenu,
  FieldFilterMenu,
  TOOLBAR_SEARCH_CLASS,
} from "./table-toolbar-menus";
import { columnMeta, filterableMeta, matchFieldFilters } from "./table-column";
import { usePagination, TablePager, DEFAULT_PAGE_SIZE } from "./table-pagination";
import { ColetaRegistrosTable } from "./coleta-registros-table";
import { useColetaRegistros } from "@/hooks/use-coleta-registros";
import type { RegistroColetado } from "@/lib/api/coleta-registros";
import { useRouter } from "next/navigation";
import { CockpitToast } from "./cockpit-toast";
import type { WorkbenchScopeRef } from "./use-workbench-layout";

const RUNNING_POLL_MS = 3000;
const FALLBACK_POLL_MS = 5000;

type Subtab = "execucoes" | "dados" | "escopo" | "agendamento" | "logs";
type FonteTab = "todas" | OrigemKey;

const FONTE_TABS: { value: FonteTab; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "effecti", label: "Effecti" },
  { value: "nomus", label: "Nomus" },
  { value: "gmail", label: "Gmail" },
  { value: "drive", label: "Drive" },
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

const DADOS_BLOCKS = ["fontes", "busca"] as const;

// Metadados das colunas para os menus icon-only da toolbar (visibilidade e
// filtro por campo). Derivados das mesmas listas que as tabelas renderizam.
const RUNS_COL_META = columnMeta(RUNS_COLUMNS);
const RUNS_FILTER_META = filterableMeta(RUNS_COLUMNS);

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

type Toast = { message: string } | null;

/**
 * Filtro de execucao da guia "Dados": recorta a lista nos registros captados
 * por UMA rodada de coleta. Setado ao clicar numa linha da guia "Execucoes";
 * a janela [de, ate] e o intervalo de captacao da execucao (fim em andamento =
 * "agora"). `label` e a data/hora de inicio formatada para o chip dispensavel.
 */
type ExecFilter = {
  fonte: OrigemKey;
  de: string;
  ate: string;
  label: string;
};

export function ColetaClient({
  agendamentos,
  escopo,
}: {
  agendamentos: AgendamentosColetaData;
  escopo: EscopoColetaData;
}) {
  const [subtab, setSubtab] = useState<Subtab>("execucoes");

  // Fonte pre-selecionada da guia Logs. Definida ao clicar numa execucao
  // (abre Logs ja filtrado pela fonte da execucao); zerada ao abrir Logs
  // manualmente pela barra de guias (volta a mostrar todas as fontes).
  const [logsFonte, setLogsFonte] = useState<ColetaLogOrigem | undefined>(undefined);

  // Filtro de execucao da guia Dados (setado ao clicar numa linha de Execucoes).
  // Abrir a guia Dados pela barra de guias zera o recorte (volta a lista cheia).
  const [execFilter, setExecFilter] = useState<ExecFilter | null>(null);

  const handleSubtabChange = (next: Subtab) => {
    if (next === "logs") setLogsFonte(undefined);
    if (next === "dados") setExecFilter(null);
    setSubtab(next);
  };

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
  const [dBusca, setDBusca] = useState("");

  // Trocar de fonte zera o recurso (single-select por fonte, igual protótipo).
  const handleFonteChange = (next: FonteTab) => {
    setFonte(next);
    setRecurso("todos");
  };
  // Trocar a fonte manualmente sai do contexto da execucao (limpa o recorte).
  const handleDFonteChange = (next: FonteTab) => {
    setDFonte(next);
    setExecFilter(null);
  };

  // Colunas ocultas + filtros por campo (controles icon-only da toolbar).
  const [runsHidden, setRunsHidden] = useState<Set<string>>(() => new Set());
  const [runsFieldFilters, setRunsFieldFilters] = useState<Record<string, string>>(
    {},
  );

  const toggleHidden = (set: typeof setRunsHidden) => (id: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [toast, setToast] = useState<Toast>(null);

  // Disparo manual da coleta por fonte. Sem GitHub Actions (desativado 28/06):
  // a coleta roda so em Supabase Edge (Effecti, Gmail, Drive) e no PC local
  // (Nomus). Effecti/Gmail/Drive disparam a Edge nativa do Supabase. Nomus nao
  // fala com a Edge (TLS CBC legado), entao o cockpit ENFILEIRA o comando na
  // fila comando_local e o servico de poll do PC executa (mesmo canal da guia
  // Escopo), por recurso (nomus-processos / nomus-pessoas).
  const coletaEffecti = useColetaDemanda();
  const coletaGmail = useDispararGmail();
  const coletaDrive = useDispararDrive();
  const enfileirarNomus = useEnfileirarComandoLocal();
  const coletando =
    coletaEffecti.isPending ||
    coletaGmail.isPending ||
    coletaDrive.isPending ||
    enfileirarNomus.isPending;

  // Recursos ativos do Nomus (so quando a fonte selecionada e Nomus): alimentam
  // o seletor de recurso com pessoas/processos mesmo sem execucao previa.
  const nomusConfig = useIngestaoConfig("nomus", { enabled: fonte === "nomus" });

  const { connected } = useExecucoesRealtime();
  const execucoes = useExecucoes({
    limit: 200,
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      if (items.some((r) => r.status === "em_andamento")) return RUNNING_POLL_MS;
      return connected ? false : FALLBACK_POLL_MS;
    },
  });

  // Enriquece cada execucao com o horario agendado da sua fonte/recurso (lido
  // do agendamento da Coleta) para a coluna "Agendado" da RunsTable.
  const allRuns = useMemo<RunComAgenda[]>(
    () =>
      (execucoes.data?.items ?? []).map((r) => ({
        ...r,
        horarioAgendado: horarioAgendadoDaFonte(
          normalizeOrigem(r.origem),
          r.recurso,
          agendamentos,
        ),
      })),
    [execucoes.data, agendamentos],
  );

  // Contagens honestas do universo completo (servidor); enquanto carregam, os
  // badges caem no universo ja em memoria (`allRuns`) como fallback.
  const contagens = execucoes.data?.contagens;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // Recursos da fonte selecionada (Execuções), derivados do dado real.
  const recursoOptions = useMemo<RecursoOption[]>(() => {
    if (fonte === "todas") return [];
    const counts = new Map<string, number>();
    // Conta pelo universo COMPLETO (contagens do servidor); enquanto carrega,
    // cai no universo em memoria (allRuns).
    if (contagens) {
      for (const [rec, n] of Object.entries(contagens.porRecurso[fonte] ?? {})) {
        counts.set(rec, n);
      }
    } else {
      for (const r of allRuns) {
        if (normalizeOrigem(r.origem) !== fonte || !r.recurso) continue;
        counts.set(r.recurso, (counts.get(r.recurso) ?? 0) + 1);
      }
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
  }, [allRuns, fonte, nomusConfig.data, contagens]);

  const recursoTotal = useMemo(
    () =>
      fonte === "todas"
        ? 0
        : contagens
          ? contagens.porOrigem[fonte] ?? 0
          : allRuns.filter((r) => normalizeOrigem(r.origem) === fonte).length,
    [allRuns, fonte, contagens],
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

  // ---- Dados: hub mestre-detalhe (cursor server-side) ----
  const router = useRouter();
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);

  // Trocar de fonte/busca/execucao zera o cursor e fecha todas as expansoes
  // (per SPEC §4.4 — evita estado orfao quando a linha sai do conjunto filtrado).
  useEffect(() => {
    setCursors([]);
    setCurrentCursor(null);
    setExpandedIds(new Set());
  }, [dFonte, dBusca, execFilter]);

  // Polling adaptativo do hook cuida do intervalo; aqui so montamos os params.
  // execFilter recorta na janela de captacao da execucao clicada (a fonte ja
  // foi fixada em dFonte ao clicar, entao o filtro de fonte cobre a fonte alvo).
  const registros = useColetaRegistros({
    fonte: dFonte === "todas" ? null : dFonte,
    busca: dBusca.trim() || null,
    cursor: currentCursor,
    execDe: execFilter?.de ?? null,
    execAte: execFilter?.ate ?? null,
  });

  const registrosList = registros.data?.itens ?? [];
  const nextCursor = registros.data?.nextCursor ?? null;
  const registrosTotal = registros.data?.contagensPorFonte?.total ?? 0;
  const pageNumber = cursors.length + 1;

  // Paginacao por cursor server-side: empilha o cursor atual ao avancar;
  // desempilha ao voltar. Sem nextCursor = fim dos resultados.
  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursors((prev) => [...prev, currentCursor ?? ""]);
    setCurrentCursor(nextCursor);
  };
  const handlePrevPage = () => {
    if (cursors.length === 0) return;
    const previous = cursors[cursors.length - 1];
    setCursors((prev) => prev.slice(0, -1));
    setCurrentCursor(previous === "" ? null : previous);
  };

  // Expansao multipla (Set de idComposto). Paginacao/fechamento e externo.
  const handleToggleExpand = (idComposto: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(idComposto)) next.delete(idComposto);
      else next.add(idComposto);
      return next;
    });
  };
  const handleCloseExpand = (idComposto: string) => {
    setExpandedIds((prev) => {
      if (!prev.has(idComposto)) return prev;
      const next = new Set(prev);
      next.delete(idComposto);
      return next;
    });
  };

  // "Triar aviso" leva a /edital/[avisoId] (Effecti-only). Sem avisoId a
  // propria linha desabilita o botao, entao aqui so chega com ID valido.
  const handleTriarAviso = (registro: RegistroColetado) => {
    if (!registro.avisoId) return;
    router.push(`/edital/${registro.avisoId}`);
  };

  // Contagem por fonte (badge da tab Dados) vinda do novo hub multi-fonte.
  const dadoFonteCount = (tab: FonteTab): number => {
    const c = registros.data?.contagensPorFonte;
    if (!c) return 0;
    if (tab === "todas") return c.total;
    return c[tab] ?? 0;
  };

  // Total de registros do conjunto PAGINADO (para o "Página X de Y" do rodapé,
  // igual à guia Execuções). As contagensPorFonte são cumulativas e refletem
  // exatamente o filtro de fonte; com busca textual OU filtro de execução ativo
  // o total do conjunto recortado não é conhecido (o Edge não devolve count do
  // termo nem da janela), então fica indeterminado e o rodapé cai em "Página X"
  // sem inventar um total.
  const dadosTotal = dBusca.trim() || execFilter
    ? undefined
    : dFonte === "todas"
      ? registrosTotal
      : dadoFonteCount(dFonte);
  const dadosTotalPages =
    dadosTotal && dadosTotal > 0
      ? Math.max(1, Math.ceil(dadosTotal / DEFAULT_PAGE_SIZE))
      : undefined;

  // Paginacao client-side (25 por pagina) sobre as listas ja filtradas. O
  // resetKey volta a pagina 1 sempre que o criterio de filtro muda.
  const runsPage = usePagination(
    runs,
    DEFAULT_PAGE_SIZE,
    `${fonte}|${recurso}|${busca}|${JSON.stringify(runsFieldFilters)}`,
  );

  // Contagem por fonte (badge dos filtros). Usa as contagens honestas do
  // servidor (universo completo); enquanto carregam, cai no universo em memoria.
  const fonteCount = (tab: FonteTab, raw: Execucao[]) =>
    contagens
      ? tab === "todas"
        ? contagens.total
        : contagens.porOrigem[tab] ?? 0
      : tab === "todas"
        ? raw.length
        : raw.filter((r) => normalizeOrigem(r.origem) === tab).length;

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
      // Nomus roda no PC local: o cockpit enfileira o comando na fila
      // comando_local (o poll do PC executa). O recurso selecionado decide o
      // alvo; "Todos" enfileira processos E pessoas. allSettled para que um 409
      // (ja na fila) de um recurso nao impeca o outro de entrar.
      if (coletando) return;
      const alvos: ComandoLocalTipo[] =
        recurso === "processos"
          ? ["nomus-processos"]
          : recurso === "pessoas"
            ? ["nomus-pessoas"]
            : ["nomus-processos", "nomus-pessoas"];
      const resultados = await Promise.allSettled(
        alvos.map((c) => enfileirarNomus.mutateAsync(c)),
      );
      const labelRecurso = (c: ComandoLocalTipo) =>
        c === "nomus-pessoas" ? "pessoas" : "processos";
      const enfileirados = alvos
        .filter((_, i) => resultados[i].status === "fulfilled")
        .map(labelRecurso);
      const duplicado = resultados.some(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof ApiError &&
          r.reason.status === 409,
      );
      if (enfileirados.length > 0) {
        setToast({
          message: `Coleta Nomus enfileirada (${enfileirados.join(" e ")}) · roda no PC local.`,
        });
      } else if (duplicado) {
        setToast({
          message: "Coleta Nomus já está na fila; aguarde a conclusão.",
        });
      } else {
        setToast({
          message: "Não foi possível enfileirar a coleta do Nomus. Tente novamente.",
        });
      }
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

  // Re-varredura full de processos: enfileira 'nomus-processos-full' (o poll do
  // PC re-coleta TODOS os processos dentro do corte de idade p/ pegar mudancas
  // de etapa que a coleta incremental por id nunca reve; processos nao tem 2a
  // passada por dataModificacao como pessoas). So aparece com Nomus+processos.
  async function handleRevarrerFull() {
    if (coletando) return;
    try {
      await enfileirarNomus.mutateAsync("nomus-processos-full");
      setToast({
        message: "Re-varredura full de processos enfileirada · roda no PC local.",
      });
    } catch (err) {
      setToast({
        message:
          err instanceof ApiError && err.status === 409
            ? "Re-varredura full já está na fila; aguarde a conclusão."
            : "Não foi possível enfileirar a re-varredura. Tente novamente.",
      });
    }
  }

  // A re-varredura full só faz sentido para processos do Nomus (com "Todos"
  // inclui processos). O botão secundário acompanha esse filtro.
  const mostrarRevarrerFull =
    fonte === "nomus" && (recurso === "processos" || recurso === "todos");

  return (
    <>
      <Subtabs<Subtab>
        ariaLabel="Guias do submódulo Coleta"
        value={subtab}
        onValueChange={handleSubtabChange}
        items={[
          { value: "execucoes", label: "Execuções", count: contagens?.total ?? allRuns.length },
          { value: "dados", label: "Dados", count: registrosTotal },
          { value: "escopo", label: "Escopo" },
          { value: "agendamento", label: "Agendamento", count: agendamentosAtivos },
          { value: "logs", label: "Logs" },
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
                  : recurso !== "todos"
                    ? `Coletar ${origemLabel(fonte)} ${recurso}`
                    : `Coletar ${origemLabel(fonte)}`
            }
            onAction={handleColetarAgora}
            actionDisabled={coletando}
            actionTitle={
              fonte === "todas"
                ? "Selecione uma fonte para coletar"
                : fonte === "nomus"
                  ? "Enfileira a coleta do Nomus para o PC local (recurso selecionado)"
                  : `Disparar coleta ${origemLabel(fonte)}`
            }
            secondaryActionLabel={mostrarRevarrerFull ? "Re-varrer (full)" : undefined}
            onSecondaryAction={handleRevarrerFull}
            secondaryActionDisabled={coletando}
            secondaryActionTitle="Re-coleta todos os processos dentro do corte de idade para pegar mudanças de etapa (roda no PC local)"
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
              tempoReal: (
                <span className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-muted">
                  <span
                    aria-hidden="true"
                    className={
                      connected
                        ? "size-2 animate-pulse rounded-full bg-ok"
                        : "size-2 rounded-full bg-warn"
                    }
                  />
                  {connected ? "Tempo real ativo" : "Reconectando…"}
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
              onRowClick={(run) => {
                // Clicar na linha leva a guia Dados recortada nos registros
                // captados POR esta execucao (fonte da execucao + janela de
                // captacao [inicio, fim ?? agora]). Fixa a fonte em dFonte para
                // os chips/filtros baterem com o conjunto recortado.
                const fonte = normalizeOrigem(run.origem);
                setDFonte(fonte);
                setExecFilter({
                  fonte,
                  de: run.inicio,
                  ate: run.fim ?? new Date().toISOString(),
                  label: formatDateTime(run.inicio),
                });
                setSubtab("dados");
              }}
              onLogClick={(run) => {
                // Botao de log da linha: abre a guia Logs ja filtrada pela fonte
                // da execucao (console ao vivo daquela coleta).
                setLogsFonte(normalizeOrigem(run.origem));
                setSubtab("logs");
              }}
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
              busca: (
                <input
                  type="search"
                  value={dBusca}
                  onChange={(e) => setDBusca(e.target.value)}
                  placeholder="Buscar por título, órgão ou identificador"
                  aria-label="Buscar dados coletados"
                  className={TOOLBAR_SEARCH_CLASS}
                />
              ),
            }}
          >
            {execFilter ? (
              <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-[18px] py-2.5 text-[13px]">
                <span className="text-muted">Filtrando pela execução</span>
                <span className="pill src">{origemLabel(execFilter.fonte)}</span>
                <span className="font-medium tabular-nums text-fg">{execFilter.label}</span>
                <button
                  type="button"
                  onClick={() => setExecFilter(null)}
                  aria-label="Limpar filtro de execução"
                  title="Limpar filtro de execução"
                  className="ml-1 grid size-6 place-items-center rounded-sm border border-border text-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </div>
            ) : null}
            <ColetaRegistrosTable
              registros={registrosList}
              loading={registros.isLoading}
              error={registros.isError}
              onRetry={() => registros.refetch()}
              expanded={expandedIds}
              onToggleExpand={handleToggleExpand}
              onCloseExpand={handleCloseExpand}
              onTriarAviso={handleTriarAviso}
              pagination={{
                page: pageNumber,
                hasPrev: cursors.length > 0,
                hasNext: nextCursor !== null,
                onPrev: handlePrevPage,
                onNext: handleNextPage,
                isFetching: registros.isFetching,
                total: dadosTotal,
                totalPages: dadosTotalPages,
              }}
              emptyTitle={
                dFonte !== "todas" || dBusca.trim()
                  ? "Nenhum registro para o filtro"
                  : "Nenhum registro nesta guia"
              }
              emptyDescription={
                dFonte !== "todas" || dBusca.trim()
                  ? "Ajuste a busca ou a fonte para ver os registros coletados."
                  : "Ainda não há registros coletados. Dispare uma coleta para começar a trazer dados."
              }
            />
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

      {subtab === "logs" && (
        <div data-subpane="coleta-logs" data-scope="ingestao/coleta/logs">
          <LogsConsole fonteInicial={logsFonte} />
        </div>
      )}

      {toast ? <CockpitToast kind="info" message={toast.message} /> : null}
    </>
  );
}
