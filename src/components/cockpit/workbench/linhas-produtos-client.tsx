"use client";

// =====================================================================
// LinhasProdutosClient — view Linhas de produtos (Cadastros) sobre o
// WorkbenchTemplate.
//
// Reusa 100% o WorkbenchTemplate da Sprint 8, parametrizando escopo, labels,
// colunas (LinhasProdutosTable) e os itens do ActionModal (que incluem
// "Mesclar", exclusivo de Linhas). Sem Subtabs (Cadastros), seguindo o
// artifact (#panel-linhas-produtos / data-subpane="linhas").
//
// Sem fonte de dados nativa, a lista nasce em empty-state HONESTO; os tres
// estados de tabela EC-09/10/11 seguem suportados. Acoes read-only
// (Conflito 04): clique abre o ActionModal e o lote apenas avisa.
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { WorkbenchTemplate } from "./workbench-template";
import {
  LinhasProdutosTable,
  type LinhaProdutoRow,
} from "./linhas-produtos-table";
import { BulkBar, type BulkAction } from "./bulk-bar";
import { ActionModal, type ActionOption } from "./action-modal";
import type { WorkbenchScopeRef } from "./use-workbench-layout";

type Categoria =
  | "todas"
  | "suprimentos"
  | "tecnologia"
  | "servicos"
  | "infraestrutura";

const CATEGORIA_TABS: { value: Categoria; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "suprimentos", label: "Suprimentos" },
  { value: "tecnologia", label: "Tecnologia" },
  { value: "servicos", label: "Serviços" },
  { value: "infraestrutura", label: "Infraestrutura" },
];

const ESTADO_OPCOES = [
  { value: "todos", label: "Todos os estados" },
  { value: "ativo", label: "Ativo" },
  { value: "inativo", label: "Inativo" },
  { value: "rascunho", label: "Rascunho" },
] as const;

const AREA_OPCOES = [
  { value: "todas", label: "Todas as áreas" },
  { value: "Compras", label: "Compras" },
  { value: "TI", label: "TI" },
  { value: "Manutenção", label: "Manutenção" },
  { value: "Serviços Gerais", label: "Serviços Gerais" },
] as const;

const BULK_ACTIONS: readonly BulkAction[] = [
  { id: "ativar", label: "Ativar" },
  { id: "inativar", label: "Inativar" },
  { id: "exportar", label: "Exportar" },
  { id: "excluir", label: "Excluir" },
];

const LINHA_ACTIONS: readonly ActionOption[] = [
  {
    id: "detalhe",
    label: "Ver detalhe",
    description: "Abre a ficha completa da linha de produtos.",
  },
  {
    id: "duplicar",
    label: "Duplicar",
    description: "Cria uma cópia editável desta linha.",
  },
  {
    id: "historico",
    label: "Histórico",
    description: "Mostra as alterações registradas da linha.",
  },
  {
    id: "mesclar",
    label: "Mesclar",
    description: "Une esta linha a outra família do catálogo.",
  },
  {
    id: "inativar",
    label: "Inativar",
    description: "Tira a linha das listas ativas.",
  },
  {
    id: "exportar",
    label: "Exportar",
    description: "Gera uma planilha com esta linha.",
  },
  {
    id: "excluir",
    label: "Excluir",
    description: "Remove a linha do catálogo.",
  },
];

const LINHAS_BLOCKS = [
  "fontes",
  "busca",
  "filtros",
  "acao-principal",
  "lote",
  "acoes-linha",
] as const;

const LINHAS_SCOPE: WorkbenchScopeRef = {
  modulo: "cadastros",
  tela: "linhas-produtos",
  guia: "linhas",
};

type ModalState = { id: string; title: string } | null;
type Toast = { message: string } | null;

export function LinhasProdutosClient() {
  const [categoria, setCategoria] = useState<Categoria>("todas");
  const [busca, setBusca] = useState("");
  const [estado, setEstado] = useState<string>("todos");
  const [area, setArea] = useState<string>("todas");

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<string>(BULK_ACTIONS[0].id);

  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<Toast>(null);

  // Sem fonte de dados nativa: empty-state honesto (sem fabricar linhas).
  const linhas = useMemo<LinhaProdutoRow[]>(() => [], []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

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
    return !linhas.some((l) => l.id === modal.id);
  }, [modal, linhas]);

  const filtroAtivo =
    categoria !== "todas" ||
    estado !== "todos" ||
    area !== "todas" ||
    busca.trim() !== "";

  function handleReadOnly(message: string) {
    setToast({ message });
  }

  return (
    <div data-subpane="linhas" data-scope="cadastros/linhas-produtos/linhas">
      <WorkbenchTemplate
        scope={LINHAS_SCOPE}
        workbenchKey="linhas-produtos"
        title="Famílias"
        description="Famílias que agrupam os produtos do catálogo por segmento. Cada linha reúne itens afins, define a área responsável e organiza a busca dentro de Produtos."
        countLabel={`${linhas.length} linhas`}
        actionLabel="Nova linha de produto"
        onAction={() =>
          handleReadOnly("Apenas leitura — nenhuma linha foi criada.")
        }
        blocks={LINHAS_BLOCKS}
        slots={{
          fontes: (
            <Tabs<Categoria>
              ariaLabel="Filtrar linhas por categoria"
              className="border-b-0 px-0"
              value={categoria}
              onValueChange={setCategoria}
              items={CATEGORIA_TABS.map((t) => ({
                value: t.value,
                label: t.label,
                count: 0,
              }))}
            />
          ),
          busca: (
            <input
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por código, linha ou responsável"
              aria-label="Buscar linhas de produtos"
              className="h-[30px] w-full max-w-[280px] rounded-sm border border-border bg-surface px-2.5 text-[13px] text-fg placeholder:text-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
            />
          ),
          filtros: (
            <span className="flex flex-wrap items-center gap-2.5">
              <label className="sr-only" htmlFor="linhas-estado">
                Filtrar por estado
              </label>
              <select
                id="linhas-estado"
                value={estado}
                onChange={(e) => setEstado(e.target.value)}
                className="h-[30px] rounded-sm border border-border bg-surface px-2.5 text-[12.5px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
              >
                {ESTADO_OPCOES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="linhas-area">
                Filtrar por área responsável
              </label>
              <select
                id="linhas-area"
                value={area}
                onChange={(e) => setArea(e.target.value)}
                className="h-[30px] rounded-sm border border-border bg-surface px-2.5 text-[12.5px] text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
              >
                {AREA_OPCOES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <Button
                variant="default"
                size="sm"
                type="button"
                onClick={() => {
                  setBusca("");
                  setEstado("todos");
                  setArea("todas");
                }}
              >
                Limpar
              </Button>
            </span>
          ),
          lote: (
            <BulkBar
              selectedCount={selectedIds.size}
              actions={BULK_ACTIONS}
              actionId={bulkAction}
              onActionChange={setBulkAction}
              onClear={clearSelection}
              onExecute={() =>
                handleReadOnly(
                  "Apenas leitura — nenhuma ação em lote foi aplicada.",
                )
              }
            />
          ),
        }}
      >
        <LinhasProdutosTable
          linhas={linhas}
          loading={false}
          error={false}
          onRetry={() => undefined}
          onItemClick={(linha) =>
            setModal({ id: linha.id, title: `Linha · ${linha.descricao}` })
          }
          selectedIds={selectedIds}
          onToggle={toggle}
          onToggleAll={toggleAll}
          emptyTitle={
            filtroAtivo
              ? "Nenhuma linha para o filtro"
              : "Nenhuma linha nesta guia"
          }
          emptyDescription={
            filtroAtivo
              ? "Ajuste a busca, troque o filtro ou a categoria para ver outras linhas."
              : "Ainda não há linhas cadastradas. Use “Nova linha de produto” para agrupar produtos do catálogo."
          }
        />
      </WorkbenchTemplate>

      <ActionModal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal?.title ?? "Ações"}
        description={modalObsolete ? undefined : "Escolha uma ação para esta linha."}
        obsolete={modalObsolete}
        options={LINHA_ACTIONS}
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
    </div>
  );
}
