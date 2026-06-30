"use client";

// =====================================================================
// ProdutosClient — view Catálogo de Produtos (Cadastros) sobre o
// WorkbenchTemplate. Fonte de dados = useProdutos() (lista geral
// filtrada por linha via Tabs). Clicar num produto navega para a ficha
// completa em /produtos/[produtoId] (rota legada, mantida). ActionModal
// continua read-only ate a fase de gravacao do modulo.
//
// Design Lock preservado: Tabs no topo (banda topo), busca, filtros
// por campo, table-states EC-09/10/11, pager, ActionModal read-only.
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { useLinhas } from "@/hooks/use-linhas";
import { useProdutos } from "@/hooks/use-produtos";
import type { Produto, ProdutoLinha } from "@/lib/api/types";
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

type LinhaTab = string; // value = linha_id OU "todas"
const TODAS = "todas";

// Metadados das colunas para os menus icon-only da toolbar.
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

/** Mapear Produto do banco para a linha read-only da tabela da Workbench. */
function toProdutoRow(p: Produto, linhaById: Record<string, ProdutoLinha>): ProdutoRow {
  const linha = linhaById[p.linha_id];
  return {
    id: p.id,
    codigo: p.nome,
    descricao: p.descricao ?? "—",
    origem: linha?.nome ?? "Sem linha",
    estado: p.ativo
      ? { state: "ok", label: "Ativo" }
      : { state: "idle", label: "Inativo" },
  };
}

export function ProdutosClient() {
  const router = useRouter();
  const [selectedLinhaId, setSelectedLinhaId] = useState<LinhaTab>(TODAS);
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

  // Fonte de dados. Linhas alimenta as Tabs; Produtos a tabela (filtra por
  // linha_id quando selecionada).
  const linhasQuery = useLinhas({ limit: 1000 });
  const produtosParams = useMemo(
    () => ({
      ...(selectedLinhaId !== TODAS ? { linha_id: selectedLinhaId } : {}),
      limit: 1000,
    }),
    [selectedLinhaId],
  );
  const produtosQuery = useProdutos(produtosParams);

  // Mapa linha_id -> linha (para resolver a origem exibida na tabela).
  const linhaById = useMemo(() => {
    const acc: Record<string, ProdutoLinha> = {};
    for (const l of linhasQuery.data?.items ?? []) acc[l.id] = l;
    return acc;
  }, [linhasQuery.data]);

  // Tabs por linha: item "Todos" + 1 por linha (com contagem).
  const linhaTabs = useMemo(() => {
    const linhas = linhasQuery.data?.items ?? [];
    const todosCount = produtosQuery.data?.items?.length ?? 0;
    const countsByLinha: Record<string, number> = {};
    // Contagem local baseada na lista carregada (limit=1000 cobre o catalogo
    // atual; se passar, adicionar RPC de contagem por linha).
    for (const p of linhas) countsByLinha[p.id] = 0;
    return [
      { value: TODAS, label: "Todos", count: todosCount },
      ...linhas.map((l) => ({
        value: l.id,
        label: l.nome,
        count: countsByLinha[l.id] ?? 0,
      })),
    ];
  }, [linhasQuery.data, produtosQuery.data]);

  const allProdutos = useMemo<ProdutoRow[]>(
    () => (produtosQuery.data?.items ?? []).map((p) => toProdutoRow(p, linhaById)),
    [produtosQuery.data, linhaById],
  );
  const produtos = useMemo(
    () =>
      allProdutos.filter((p) =>
        matchFieldFilters(p, PRODUTOS_COLUMNS, fieldFilters),
      ),
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
    selectedLinhaId !== TODAS ||
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
            <Tabs<LinhaTab>
              ariaLabel="Filtrar produtos por linha"
              className="border-b-0 px-0"
              value={selectedLinhaId}
              onValueChange={setSelectedLinhaId}
              items={linhaTabs}
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
          loading={produtosQuery.isLoading}
          error={produtosQuery.isError}
          onRetry={() => produtosQuery.refetch()}
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
              ? "Ajuste a busca, troque o filtro ou a linha para ver outros produtos."
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
        onAction={(id) => {
          if (id === "detalhe" && modal) {
            router.push(`/produtos/${modal.id}`);
            setModal(null);
            return;
          }
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
