"use client";

// =====================================================================
// ProdutosClient — view Produtos do modulo Cadastros sobre o WorkbenchTemplate.
//
// Reusa 100% o WorkbenchTemplate da Sprint 8, parametrizando escopo, labels,
// colunas (ProdutosTable) e os itens do ActionModal. Diferente da Coleta,
// Cadastros NAO tem Subtabs (Execuções/Dados): segue a estrutura do artifact
// (#panel-produtos / data-subpane="catalogo").
//
// Sem fonte de dados nativa no cockpit, a lista nasce em empty-state HONESTO
// (sem fabricar registros) — os tres estados de tabela EC-09/10/11 continuam
// suportados pela ProdutosTable. Acoes operacionais sao read-only (Conflito 04):
// clique abre o ActionModal e o lote dispara apenas o aviso "Apenas leitura".
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { WorkbenchTemplate } from "./workbench-template";
import { ProdutosTable, PRODUTOS_COLUMNS, type ProdutoRow } from "./produtos-table";
import { ActionModal, type ActionOption } from "./action-modal";
import {
  ColumnToggleMenu,
  FieldFilterMenu,
  TOOLBAR_SEARCH_CLASS,
} from "./table-toolbar-menus";
import { columnMeta, filterableMeta, matchFieldFilters } from "./table-column";
import { usePagination, TablePager } from "./table-pagination";
import type { WorkbenchScopeRef } from "./use-workbench-layout";

type Categoria =
  | "todas"
  | "suprimentos"
  | "tecnologia"
  | "servicos"
  | "infraestrutura";

const CATEGORIA_TABS: { value: Categoria; label: string }[] = [
  { value: "todas", label: "Todos" },
  { value: "suprimentos", label: "Suprimentos" },
  { value: "tecnologia", label: "Tecnologia" },
  { value: "servicos", label: "Serviços" },
  { value: "infraestrutura", label: "Infraestrutura" },
];

// Metadados das colunas para os menus icon-only da toolbar (visibilidade e
// filtro por campo), derivados das mesmas colunas que a tabela renderiza.
const PRODUTOS_COL_META = columnMeta(PRODUTOS_COLUMNS);
const PRODUTOS_FILTER_META = filterableMeta(PRODUTOS_COLUMNS);

const PRODUTO_ACTIONS: readonly ActionOption[] = [
  {
    id: "detalhe",
    label: "Ver detalhe",
    description: "Abre a ficha completa do produto.",
  },
  {
    id: "duplicar",
    label: "Duplicar",
    description: "Cria uma cópia editável deste produto.",
  },
  {
    id: "historico",
    label: "Histórico",
    description: "Mostra as alterações registradas do item.",
  },
  {
    id: "inativar",
    label: "Inativar",
    description: "Tira o produto das listas ativas.",
  },
  {
    id: "exportar",
    label: "Exportar",
    description: "Gera uma planilha com este produto.",
  },
  {
    id: "excluir",
    label: "Excluir",
    description: "Remove o produto do catálogo.",
  },
];

const PRODUTOS_BLOCKS = [
  "fontes",
  "busca",
  "filtros",
  "acao-principal",
  "acoes-linha",
] as const;

const PRODUTOS_SCOPE: WorkbenchScopeRef = {
  modulo: "cadastros",
  tela: "produtos",
  guia: "catalogo",
};

type ModalState = { id: string; title: string } | null;
type Toast = { message: string } | null;

export function ProdutosClient() {
  const [categoria, setCategoria] = useState<Categoria>("todas");
  const [busca, setBusca] = useState("");

  // Colunas ocultas + filtros por campo (controles icon-only da toolbar).
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [fieldFilters, setFieldFilters] = useState<Record<string, string>>({});

  const toggleHidden = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<Toast>(null);

  // Sem fonte de dados nativa: empty-state honesto (sem fabricar produtos).
  const allProdutos = useMemo<ProdutoRow[]>(() => [], []);
  const produtos = useMemo(
    () => allProdutos.filter((p) => matchFieldFilters(p, PRODUTOS_COLUMNS, fieldFilters)),
    [allProdutos, fieldFilters],
  );

  // Paginacao client-side (25 por pagina) sobre a lista ja filtrada.
  const produtosPage = usePagination(produtos);

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

  // EC-13: item obsoleto quando saiu da lista entre o clique e a abertura.
  const modalObsolete = useMemo(() => {
    if (!modal) return false;
    return !produtos.some((p) => p.id === modal.id);
  }, [modal, produtos]);

  const filtroAtivo =
    categoria !== "todas" ||
    busca.trim() !== "" ||
    Object.values(fieldFilters).some((v) => v.trim());

  function handleReadOnly(message: string) {
    setToast({ message });
  }

  return (
    <div data-subpane="catalogo" data-scope="cadastros/produtos/catalogo">
      <WorkbenchTemplate
        scope={PRODUTOS_SCOPE}
        workbenchKey="produtos"
        title="Catálogo"
        description="Itens cadastrados para licitações. Cada item pertence a uma linha de produtos e traz unidade, preço de referência e fornecedor habitual."
        countLabel={`${produtos.length} produtos`}
        actionLabel="Novo produto"
        onAction={() =>
          handleReadOnly("Apenas leitura — nenhum produto foi criado.")
        }
        blocks={PRODUTOS_BLOCKS}
        slots={{
          fontes: (
            <Tabs<Categoria>
              ariaLabel="Filtrar produtos por categoria"
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
              placeholder="Buscar por código, nome ou fornecedor"
              aria-label="Buscar produtos"
              className={TOOLBAR_SEARCH_CLASS}
            />
          ),
          filtros: (
            <span className="flex items-center gap-2.5">
              <FieldFilterMenu
                columns={PRODUTOS_FILTER_META}
                values={fieldFilters}
                onChange={(id, value) =>
                  setFieldFilters((p) => ({ ...p, [id]: value }))
                }
                onClear={() => setFieldFilters({})}
              />
              <ColumnToggleMenu
                columns={PRODUTOS_COL_META}
                hidden={hidden}
                onToggle={toggleHidden}
                onShowAll={() => setHidden(new Set())}
              />
            </span>
          ),
        }}
      >
        <ProdutosTable
          produtos={produtosPage.pageItems}
          loading={false}
          error={false}
          onRetry={() => undefined}
          hidden={hidden}
          onItemClick={(produto) =>
            setModal({ id: produto.id, title: `Produto · ${produto.descricao}` })
          }
          selectedIds={selectedIds}
          onToggle={toggle}
          onToggleAll={toggleAll}
          emptyTitle={
            filtroAtivo
              ? "Nenhum produto para o filtro"
              : "Nenhum produto nesta guia"
          }
          emptyDescription={
            filtroAtivo
              ? "Ajuste a busca, troque o filtro ou a categoria para ver outros produtos."
              : "Ainda não há produtos cadastrados. Use “Novo produto” para começar o catálogo."
          }
        />
        <TablePager {...produtosPage} />
      </WorkbenchTemplate>

      <ActionModal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal?.title ?? "Ações"}
        description={modalObsolete ? undefined : "Escolha uma ação para este produto."}
        obsolete={modalObsolete}
        options={PRODUTO_ACTIONS}
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
