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
import { WorkbenchTemplate } from "./workbench-template";
import {
  LinhasProdutosTable,
  LINHAS_COLUMNS,
  type LinhaProdutoRow,
} from "./linhas-produtos-table";
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
  { value: "todas", label: "Todas" },
  { value: "suprimentos", label: "Suprimentos" },
  { value: "tecnologia", label: "Tecnologia" },
  { value: "servicos", label: "Serviços" },
  { value: "infraestrutura", label: "Infraestrutura" },
];

// Metadados das colunas para os menus icon-only da toolbar (visibilidade e
// filtro por campo), derivados das mesmas colunas que a tabela renderiza.
const LINHAS_COL_META = columnMeta(LINHAS_COLUMNS);
const LINHAS_FILTER_META = filterableMeta(LINHAS_COLUMNS);


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

  // Sem fonte de dados nativa: empty-state honesto (sem fabricar linhas).
  const allLinhas = useMemo<LinhaProdutoRow[]>(() => [], []);
  const linhas = useMemo(
    () => allLinhas.filter((l) => matchFieldFilters(l, LINHAS_COLUMNS, fieldFilters)),
    [allLinhas, fieldFilters],
  );

  // Paginacao client-side (25 por pagina) sobre a lista ja filtrada.
  const linhasPage = usePagination(linhas);

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
    return !linhas.some((l) => l.id === modal.id);
  }, [modal, linhas]);

  const filtroAtivo =
    categoria !== "todas" ||
    busca.trim() !== "" ||
    Object.values(fieldFilters).some((v) => v.trim());

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
              className={TOOLBAR_SEARCH_CLASS}
            />
          ),
          filtros: (
            <span className="flex items-center gap-2.5">
              <FieldFilterMenu
                columns={LINHAS_FILTER_META}
                values={fieldFilters}
                onChange={(id, value) =>
                  setFieldFilters((p) => ({ ...p, [id]: value }))
                }
                onClear={() => setFieldFilters({})}
              />
              <ColumnToggleMenu
                columns={LINHAS_COL_META}
                hidden={hidden}
                onToggle={toggleHidden}
                onShowAll={() => setHidden(new Set())}
              />
            </span>
          ),
        }}
      >
        <LinhasProdutosTable
          linhas={linhasPage.pageItems}
          loading={false}
          error={false}
          onRetry={() => undefined}
          hidden={hidden}
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
        <TablePager {...linhasPage} />
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
