"use client";

// =====================================================================
// LinhasProdutosClient — view Linhas de produtos (Cadastros) sobre o
// WorkbenchTemplate. Master-detail: clicar numa linha abre, abaixo da
// tabela, o drill-down de Produtos (ProdutosDaLinha, mesmo do legado,
// reusado aqui). Fonte de dados = useLinhas() + useProdutos() (contagem
// agregada por linha). Mantem o ActionModal read-only; ver/actions sobre
// o ActionModal sao placeholders ate Fase de gravacao do modulo.
//
// Renderiza uma area de master-detail via slot `detalhe` do template
// (adicionado na sprint atual).
// =====================================================================

import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronRight,
  Package,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { Tabs } from "@/components/ui/tabs";
import { useLinhas } from "@/hooks/use-linhas";
import { useProdutos } from "@/hooks/use-produtos";
import { useLinhaAtributos } from "@/hooks/use-linha-atributos";
import type { AtributoSchema, Produto, ProdutoLinha } from "@/lib/api/types";
import { StatusPill } from "@/components/cockpit/status-pill";
import { FotoThumb } from "@/components/cockpit/produtos/foto-thumb";
import { TabelaPrecosLinha } from "@/components/cockpit/produtos/tabela-precos-linha";
import { ProdutoForm } from "@/components/cockpit/produtos/produto-form";
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

/** Mapear uma linha do banco (ProdutoLinha) para a linha read-only da tabela
 * da Workbench. Adiciona contagem de produtos e estado normalizado. */
function toLinhaRow(
  l: ProdutoLinha,
  contagemPorLinhaId: Record<string, number>,
): LinhaProdutoRow {
  return {
    id: l.id,
    codigo: l.nome,
    descricao: l.descricao ?? "—",
    produtosAssociados: contagemPorLinhaId[l.id] ?? 0,
    estado: l.ativo
      ? { state: "ok", label: "Ativa" }
      : { state: "idle", label: "Inativa" },
  };
}

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
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<Toast>(null);

  // Fonte de dados real: useLinhas (limite alto cobre o catalogo atual;
  // se passar, adicionar RPC de contagem agregada por linha).
  const linhasQuery = useLinhas({ limit: 1000 });
  const produtosQuery = useProdutos({ limit: 1000 });

  // Contagem por linha: agregacao client-side de TODOS os produtos. Uma
  // chamada so; custo equivalente ao que ja roda em Guia Dados.
  const contagemPorLinhaId = useMemo(() => {
    const acc: Record<string, number> = {};
    const items = produtosQuery.data?.items ?? [];
    for (const p of items) {
      acc[p.linha_id] = (acc[p.linha_id] ?? 0) + 1;
    }
    return acc;
  }, [produtosQuery.data]);

  const allLinhas = useMemo<LinhaProdutoRow[]>(
    () =>
      (linhasQuery.data?.items ?? []).map((l) =>
        toLinhaRow(l, contagemPorLinhaId),
      ),
    [linhasQuery.data, contagemPorLinhaId],
  );
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

  // Linha selecionada para o master-detail. Derivada da selecao por linha
  // OU do clique direto na tabela.
  const selectedLinha: ProdutoLinha | null = useMemo(() => {
    if (!selectedId) return null;
    return (
      linhasQuery.data?.items?.find((l) => l.id === selectedId) ?? null
    );
  }, [selectedId, linhasQuery.data]);

  function onItemClick(linha: LinhaProdutoRow) {
    // Toggle: clicar na linha selecionada desseleciona (mesma UX do legado).
    setSelectedId((cur) => (cur === linha.id ? null : linha.id));
  }

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
          detalhe: selectedLinha ? (
            <ProdutosDaLinha
              linha={selectedLinha}
              onClose={() => setSelectedId(null)}
            />
          ) : null,
        }}
      >
        <LinhasProdutosTable
          linhas={linhasPage.pageItems}
          loading={linhasQuery.isLoading}
          error={linhasQuery.isError}
          onRetry={() => linhasQuery.refetch()}
          hidden={hidden}
          onItemClick={onItemClick}
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

/** Drill-down dos Produtos de uma Linha + criacao de Produto com o schema
 * da Linha. Mesmo comportamento do legado: clicar num Produto abre, inline
 * abaixo dele, a tabela de precos com os SKUs daquele Produto. */
function ProdutosDaLinha({
  linha,
  onClose,
}: {
  linha: ProdutoLinha;
  onClose: () => void;
}) {
  const router = useRouter();
  const produtos = useProdutos({ linha_id: linha.id });
  const atributos = useLinhaAtributos(linha.id);
  const [creating, setCreating] = useState(false);
  const [selectedProdutoId, setSelectedProdutoId] = useState<string | null>(null);

  const items = produtos.data?.items ?? [];
  const schema: AtributoSchema[] = (atributos.data?.items ?? []).map((a) => ({
    chave: a.chave,
    tipo: a.tipo,
    obrigatorio: a.obrigatorio,
    mostra_catalogo: a.mostra_catalogo,
    mostra_ficha: a.mostra_ficha,
    origem: "linha" as const,
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-[14px] font-bold tracking-[-0.01em] text-fg">
            Produtos da linha {linha.nome}
          </h4>
          <p className="text-[12px] text-muted">
            Selecione um produto para ver os SKUs e a tabela de preços.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!creating && items.length > 0 ? (
            <button
              type="button"
              className="btn btn-sm btn-icon"
              onClick={() => setCreating(true)}
              aria-label="Novo produto"
              title="Novo produto"
            >
              <Plus aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            aria-label="Fechar detalhe"
          >
            Fechar
          </button>
        </div>
      </div>

      <div className="rounded-md border border-border bg-surface">
        {produtos.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <span key={i} className="skel skel-line" style={{ width: "100%" }} />
            ))}
          </div>
        ) : produtos.isError ? (
          <div className="err-msg" style={{ display: "flex", padding: 16 }}>
            <TriangleAlert aria-hidden="true" />
            Não foi possível carregar os produtos desta linha.
          </div>
        ) : items.length === 0 ? (
          <div className="empty">
            <Package aria-hidden="true" />
            <h4>Nenhum produto nesta linha</h4>
            <p>Crie o primeiro produto para detalhar atributos, SKUs e preços.</p>
            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setCreating(true)}
              >
                <Plus aria-hidden="true" />
                <span>Novo produto</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Produto</th>
                  <th style={{ width: 60 }} aria-label="Status" />
                  <th style={{ width: 60 }} aria-label="Editar" />
                </tr>
              </thead>
              <tbody>
                {items.map((p: Produto) => {
                  const active = p.id === selectedProdutoId;
                  const activeStyle: CSSProperties | undefined = active
                    ? { background: "var(--accent-soft)" }
                    : undefined;
                  return (
                    <Fragment key={p.id}>
                      <tr
                        className={active ? "clk active-row" : "clk"}
                        aria-selected={active}
                        onClick={() =>
                          setSelectedProdutoId((cur) =>
                            cur === p.id ? null : p.id,
                          )
                        }
                        style={activeStyle}
                      >
                        <td>
                          <div className="flex items-center gap-2.5">
                            <StatusPill
                              state={p.ativo ? "ok" : "idle"}
                              label={p.ativo ? "Ativo" : "Inativo"}
                              iconOnly
                            />
                            <FotoThumb url={p.foto_url} alt={p.nome} />
                            <div className="flex flex-col">
                              <b style={{ fontSize: "13.5px" }}>{p.nome}</b>
                              {p.descricao ? (
                                <span
                                  className="text-[12px] text-muted"
                                  style={{
                                    display: "-webkit-box",
                                    WebkitLineClamp: 2,
                                    WebkitBoxOrient: "vertical",
                                    overflow: "hidden",
                                  }}
                                >
                                  {p.descricao}
                                </span>
                              ) : null}
                              {p.disponibilidade ? (
                                <span className="text-[12px] text-muted">
                                  {p.disponibilidade}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </td>
                        <td>
                          <div
                            className="flex items-center justify-end"
                            style={{ paddingRight: 4 }}
                          >
                            <StatusPill
                              state={p.ativo ? "ok" : "idle"}
                              label=""
                              iconOnly
                            />
                          </div>
                        </td>
                        <td>
                          <div className="flex items-center justify-end">
                            <button
                              type="button"
                              className="btn btn-sm btn-icon"
                              style={{ color: "var(--accent)" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                router.push(`/produtos/${p.id}`);
                              }}
                              aria-label="Editar produto"
                              title="Editar"
                            >
                              <ChevronRight aria-hidden="true" />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {active ? (
                        <tr className="expanded-row">
                          <td
                            colSpan={3}
                            style={{ padding: 0, background: "var(--surface-2)" }}
                          >
                            <TabelaPrecosLinha
                              linhaId={linha.id}
                              produtoId={p.id}
                              embedded
                            />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {creating ? (
          <div className="border-t border-border p-4">
            <ProdutoForm
              linhaId={linha.id}
              schema={schema}
              onSuccess={(produto) => {
                setCreating(false);
                router.push(`/produtos/${produto.id}`);
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
