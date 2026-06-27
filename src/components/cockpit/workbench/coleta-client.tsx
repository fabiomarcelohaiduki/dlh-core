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
import { Check } from "lucide-react";
import { Subtabs } from "@/components/ui/subtabs";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useExecucoes } from "@/hooks/use-monitoring";
import { useExecucoesRealtime } from "@/hooks/use-execucoes-realtime";
import {
  execucaoDescriptor,
  normalizeOrigem,
  origemLabel,
  type OrigemKey,
  type PillState,
} from "@/lib/status";
import type { Execucao } from "@/lib/api/types";
import { WorkbenchTemplate } from "./workbench-template";
import { RunsTable } from "./runs-table";
import { DadosTable, type DadoColetado } from "./dados-table";
import { BulkBar, type BulkAction } from "./bulk-bar";
import { ActionModal, type ActionOption } from "./action-modal";
import type { WorkbenchScopeRef } from "./use-workbench-layout";

const RUNNING_POLL_MS = 3000;
const FALLBACK_POLL_MS = 5000;

type Subtab = "execucoes" | "dados";
type FonteTab = "todas" | OrigemKey;

const FONTE_TABS: { value: FonteTab; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "effecti", label: "Effecti" },
  { value: "nomus", label: "Nomus" },
  { value: "gmail", label: "Gmail" },
  { value: "drive", label: "Drive" },
];

const STATUS_OPCOES = [
  { value: "todos", label: "Todos os status" },
  { value: "concluida", label: "Concluída" },
  { value: "em_andamento", label: "Em execução" },
  { value: "erro", label: "Erro" },
] as const;

const BULK_ACTIONS: readonly BulkAction[] = [
  { id: "reexecutar", label: "Reexecutar agora" },
  { id: "conferir", label: "Marcar como conferida" },
  { id: "arquivar", label: "Arquivar" },
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
  "lote",
  "acoes-linha",
] as const;

const DADOS_BLOCKS = ["fontes", "recurso", "busca", "filtros", "acoes-linha"] as const;

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

type Toast = { kind: "ok" | "info"; message: string } | null;

export function ColetaClient() {
  const [subtab, setSubtab] = useState<Subtab>("execucoes");

  // Filtros da guia Execuções.
  const [fonte, setFonte] = useState<FonteTab>("todas");
  const [busca, setBusca] = useState("");
  const [status, setStatus] = useState<string>("todos");

  // Filtros da guia Dados.
  const [dFonte, setDFonte] = useState<FonteTab>("todas");
  const [dBusca, setDBusca] = useState("");
  const [dTipo, setDTipo] = useState<string>("todos");

  // Selecao em lote (Execuções) + acao contextual.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<string>(BULK_ACTIONS[0].id);

  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<Toast>(null);

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

  // ---- Execuções: filtro client-side ----
  const runs = useMemo(
    () =>
      allRuns.filter((r) => {
        if (fonte !== "todas" && normalizeOrigem(r.origem) !== fonte) return false;
        if (status !== "todos" && r.status !== status) return false;
        if (busca.trim()) {
          const q = busca.trim().toLowerCase();
          const hay = `${origemLabel(normalizeOrigem(r.origem))} ${r.recurso ?? ""} ${r.gatilho ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [allRuns, fonte, status, busca],
  );

  // ---- Dados: projecao honesta das execucoes ----
  const allDados = useMemo<DadoColetado[]>(
    () =>
      allRuns.map((r) => {
        const origem = origemLabel(normalizeOrigem(r.origem));
        return {
          id: r.id,
          titulo: `Coleta ${origem}${r.recurso ? ` · ${r.recurso}` : ""}`,
          origem,
          recurso: r.recurso,
          tipo: "Registro",
          captadoEm: r.fim ?? r.inicio,
          tamanho: `${r.novos + r.alterados} itens`,
          status: dadoStatus(r),
        };
      }),
    [allRuns],
  );

  const dados = useMemo(
    () =>
      allDados.filter((d) => {
        if (dFonte !== "todas" && normalizeOrigem(d.origem.toLowerCase()) !== dFonte)
          return false;
        if (dTipo !== "todos" && d.tipo !== dTipo) return false;
        if (dBusca.trim()) {
          const q = dBusca.trim().toLowerCase();
          const hay = `${d.titulo} ${d.recurso ?? ""} ${d.tipo}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [allDados, dFonte, dTipo, dBusca],
  );

  // Contagem por fonte (badge das guias do topo), sobre o universo carregado.
  const fonteCount = (tab: FonteTab, raw: Execucao[]) =>
    tab === "todas"
      ? raw.length
      : raw.filter((r) => normalizeOrigem(r.origem) === tab).length;

  // ---- Selecao (EC-12) ----
  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = (ids: string[], checked: boolean) =>
    setSelectedIds(() => (checked ? new Set(ids) : new Set()));
  const clearSelection = () => setSelectedIds(new Set());

  // EC-13: item obsoleto quando saiu da lista entre o clique e a abertura.
  const modalObsolete = useMemo(() => {
    if (!modal) return false;
    return !allRuns.some((r) => r.id === modal.id);
  }, [modal, allRuns]);

  function handleReadOnly(message: string) {
    setToast({ kind: "info", message });
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
        ]}
      />

      {subtab === "execucoes" ? (
        <div data-subpane="coleta-execucoes" data-scope="ingestao/coleta/execucoes">
          <WorkbenchTemplate
            scope={EXECUCOES_SCOPE}
            workbenchKey="coleta"
            title="Execuções"
            description="Execuções dos agendamentos de coleta por fonte. Cada linha é uma rodada disparada — confira se rodou, o que trouxe e quanto durou."
            countLabel={`${runs.length} execuções`}
            actionLabel="Coletar agora"
            onAction={() => handleReadOnly("Apenas leitura — a coleta não foi disparada.")}
            blocks={EXECUCOES_BLOCKS}
            slots={{
              fontes: (
                <Tabs<FonteTab>
                  ariaLabel="Filtrar execuções por fonte"
                  className="border-b-0 px-0"
                  value={fonte}
                  onValueChange={setFonte}
                  items={FONTE_TABS.map((t) => ({
                    value: t.value,
                    label: t.label,
                    count: fonteCount(t.value, allRuns),
                  }))}
                />
              ),
              busca: (
                <input
                  type="search"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder="Buscar por origem, recurso ou gatilho"
                  aria-label="Buscar execuções de coleta"
                  className="h-[30px] w-full max-w-[280px] rounded-sm border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
                />
              ),
              filtros: (
                <FiltrosStatus
                  value={status}
                  onChange={setStatus}
                  onClear={() => {
                    setBusca("");
                    setStatus("todos");
                  }}
                />
              ),
              lote: (
                <BulkBar
                  selectedCount={selectedIds.size}
                  actions={BULK_ACTIONS}
                  actionId={bulkAction}
                  onActionChange={setBulkAction}
                  onClear={clearSelection}
                  onExecute={() =>
                    handleReadOnly("Apenas leitura — nenhuma ação em lote foi aplicada.")
                  }
                />
              ),
            }}
          >
            <RunsTable
              runs={runs}
              loading={execucoes.isLoading}
              error={execucoes.isError}
              onRetry={() => execucoes.refetch()}
              onItemClick={(run) =>
                setModal({
                  kind: "run",
                  id: run.id,
                  title: `Execução · ${execucaoDescriptor(run).label}`,
                })
              }
              selectedIds={selectedIds}
              onToggle={toggle}
              onToggleAll={toggleAll}
              emptyTitle={
                fonte !== "todas" || status !== "todos" || busca.trim()
                  ? "Nenhuma execução para o filtro"
                  : "Nenhuma execução nesta guia"
              }
              emptyDescription={
                fonte !== "todas" || status !== "todos" || busca.trim()
                  ? "Ajuste a busca, o status ou a fonte para ver outras execuções."
                  : "Ainda não há coletas registradas. Use “Coletar agora” para gerar uma execução."
              }
            />
          </WorkbenchTemplate>
        </div>
      ) : (
        <div data-subpane="coleta-dados" data-scope="ingestao/coleta/dados">
          <WorkbenchTemplate
            scope={DADOS_SCOPE}
            workbenchKey="coleta-dados"
            title="Dados"
            description="Itens efetivamente capturados pelas coletas. Cada linha é um documento ou registro trazido de uma fonte de ingestão."
            countLabel={`${dados.length} itens`}
            actionLabel="Coletar agora"
            blocks={DADOS_BLOCKS}
            slots={{
              fontes: (
                <Tabs<FonteTab>
                  ariaLabel="Filtrar dados por fonte"
                  className="border-b-0 px-0"
                  value={dFonte}
                  onValueChange={setDFonte}
                  items={FONTE_TABS.map((t) => ({
                    value: t.value,
                    label: t.label,
                    count: fonteCount(t.value, allRuns),
                  }))}
                />
              ),
              busca: (
                <input
                  type="search"
                  value={dBusca}
                  onChange={(e) => setDBusca(e.target.value)}
                  placeholder="Buscar por título, recurso ou tipo"
                  aria-label="Buscar dados coletados"
                  className="h-[30px] w-full max-w-[280px] rounded-sm border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
                />
              ),
              filtros: (
                <FiltrosTipo
                  value={dTipo}
                  onChange={setDTipo}
                  onClear={() => {
                    setDBusca("");
                    setDTipo("todos");
                  }}
                />
              ),
            }}
          >
            <DadosTable
              dados={dados}
              loading={execucoes.isLoading}
              error={execucoes.isError}
              onRetry={() => execucoes.refetch()}
              onItemClick={(d) =>
                setModal({ kind: "dado", id: d.id, title: d.titulo })
              }
              emptyTitle={
                dFonte !== "todas" || dTipo !== "todos" || dBusca.trim()
                  ? "Nenhum item para o filtro"
                  : "Nenhum item nesta guia"
              }
              emptyDescription={
                dFonte !== "todas" || dTipo !== "todos" || dBusca.trim()
                  ? "Ajuste a busca ou o filtro para ver os dados coletados."
                  : "Ainda não há itens capturados. Dispare uma coleta para começar a trazer dados."
              }
            />
          </WorkbenchTemplate>
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

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2.5 text-[13px] text-fg shadow-[var(--shadow-overlay)]"
        >
          <Check aria-hidden="true" className="size-4 text-accent-strong" />
          {toast.message}
        </div>
      ) : null}
    </>
  );
}

/** Filtro de status + Limpar (guia Execuções). */
function FiltrosStatus({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  return (
    <span className="flex items-center gap-2.5">
      <label className="sr-only" htmlFor="coleta-status">
        Filtrar por status
      </label>
      <select
        id="coleta-status"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-[30px] rounded-sm border border-border bg-surface px-2.5 text-[12.5px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
      >
        {STATUS_OPCOES.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Button variant="default" size="sm" type="button" onClick={onClear}>
        Limpar
      </Button>
    </span>
  );
}

/** Filtro de tipo + Limpar (guia Dados). */
function FiltrosTipo({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  const tipos = ["todos", "Edital", "Documento", "Planilha", "E-mail", "Registro"];
  return (
    <span className="flex items-center gap-2.5">
      <label className="sr-only" htmlFor="dados-tipo">
        Filtrar por tipo
      </label>
      <select
        id="dados-tipo"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-[30px] rounded-sm border border-border bg-surface px-2.5 text-[12.5px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
      >
        {tipos.map((t) => (
          <option key={t} value={t}>
            {t === "todos" ? "Todos os tipos" : t}
          </option>
        ))}
      </select>
      <Button variant="default" size="sm" type="button" onClick={onClear}>
        Limpar
      </Button>
    </span>
  );
}
