"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  Layers,
  Loader2,
  Package,
  Plus,
  TriangleAlert,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { useLinhas, useDeleteLinha } from "@/hooks/use-linhas";
import { useLinhaAtributos } from "@/hooks/use-linha-atributos";
import { useProdutos } from "@/hooks/use-produtos";
import { ApiError } from "@/lib/api/client";
import { StatusPill } from "@/components/cockpit/status-pill";
import { LinhasTable } from "@/components/cockpit/produtos/linhas-table";
import { LinhaForm } from "@/components/cockpit/produtos/linha-form";
import { AtributosEditor } from "@/components/cockpit/produtos/atributos-editor";
import { CriteriosPanel } from "@/components/cockpit/produtos/criterios-panel";
import { ProdutoForm } from "@/components/cockpit/produtos/produto-form";
import { TabelaPrecosLinha } from "@/components/cockpit/produtos/tabela-precos-linha";
import type { AtributoSchema, ProdutoLinha } from "@/lib/api/types";

type LinhaFormMode = "none" | "new" | "edit";

/**
 * Tela /produtos (lado A do modulo): master-detail de Linhas -> Produtos. O
 * MASTER lista as Linhas (status ativo/inativo) e o DETAIL, ao selecionar,
 * abre os atributos da Linha (que definem o schema dos Produtos), os criterios
 * de cotacao/politica no nivel da Linha e o drill-down dos Produtos da Linha.
 * Estados loading/error/empty travados pelo Design Lock.
 */
export function ProdutosClient() {
  const linhas = useLinhas();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<LinhaFormMode>("none");

  const items = useMemo(() => linhas.data?.items ?? [], [linhas.data]);
  const selected = useMemo(
    () => items.find((l) => l.id === selectedId) ?? null,
    [items, selectedId],
  );

  function onSelect(linha: ProdutoLinha) {
    setSelectedId(linha.id);
    setFormMode("none");
  }

  function onNew() {
    setSelectedId(null);
    setFormMode("new");
  }

  return (
    <section className="screen">
      <div className="page-head">
        <div className="actions" style={{ marginLeft: 0 }}>
          <Link href="/produtos/novo" className="btn btn-primary">
            <Wand2 aria-hidden="true" />
            <span>Cadastro guiado</span>
          </Link>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(300px, 400px) 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <LinhasTable
          linhas={items}
          loading={linhas.isLoading}
          isError={linhas.isError}
          onRetry={() => linhas.refetch()}
          selectedId={selectedId}
          onSelect={onSelect}
          onNew={onNew}
          onEdit={(linha) => {
            setSelectedId(linha.id);
            setFormMode("edit");
          }}
        />

        <div style={{ display: "grid", gap: 16 }}>
          {formMode === "new" ? (
            <LinhaForm
              onSuccess={(linha) => {
                setSelectedId(linha.id);
                setFormMode("none");
              }}
              onCancel={() => setFormMode("none")}
            />
          ) : formMode === "edit" && selected ? (
            <LinhaEditPanel
              linha={selected}
              onExit={() => setFormMode("none")}
              onDeleted={() => {
                setSelectedId(null);
                setFormMode("none");
              }}
            />
          ) : selected ? (
            <LinhaDetail linha={selected} />
          ) : (
            <div className="card">
              <div className="empty">
                <Layers aria-hidden="true" />
                <h4>Selecione uma linha</h4>
                <p>
                  Escolha uma Linha à esquerda para ver seus atributos, critérios
                  de cotação e Produtos — ou crie uma nova.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Painel de EDICAO de uma Linha: form + atributos + exclusao. O excluir vive
 * aqui dentro do editar (a lista a esquerda so abre via simbolo laranja). */
function LinhaEditPanel({
  linha,
  onExit,
  onDeleted,
}: {
  linha: ProdutoLinha;
  onExit: () => void;
  onDeleted: () => void;
}) {
  const deleteLinha = useDeleteLinha();
  const [confirming, setConfirming] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function onConfirmDelete() {
    setErro(null);
    try {
      await deleteLinha.mutateAsync(linha.id);
      onDeleted();
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 409
          ? "Linha possui produtos vinculados. Remova os Produtos antes de excluir."
          : "Não foi possível excluir a linha. Tente novamente.",
      );
    }
  }

  return (
    <>
      <LinhaForm linha={linha} onSuccess={onExit} onCancel={onExit} />
      <AtributosEditor linhaId={linha.id} />

      <div className="section-title">
        <h3>Critérios de cotação da Linha</h3>
        <span className="count">nível linha</span>
      </div>
      <CriteriosPanel nivel="linha" escopoId={linha.id} />

      <div className="card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span className="sub">Excluir esta linha permanentemente.</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {confirming ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ color: "var(--err)" }}
                  onClick={onConfirmDelete}
                  disabled={deleteLinha.isPending}
                >
                  {deleteLinha.isPending ? (
                    <Loader2 className="spin" aria-hidden="true" />
                  ) : (
                    <Trash2 aria-hidden="true" />
                  )}
                  <span>Confirmar exclusão</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setConfirming(false);
                    setErro(null);
                  }}
                  disabled={deleteLinha.isPending}
                >
                  <X aria-hidden="true" />
                  <span>Cancelar</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirming(true)}
              >
                <Trash2 aria-hidden="true" />
                <span>Excluir linha</span>
              </button>
            )}
          </div>
        </div>
        {erro && (
          <div className="err-msg" style={{ display: "flex", marginTop: 14 }}>
            <TriangleAlert aria-hidden="true" />
            {erro}
          </div>
        )}
      </div>
    </>
  );
}

/** Painel DETAIL de uma Linha: produtos da linha (com tabela de precos inline).
 * Identidade/acoes vivem na lista a esquerda; criterios da Linha no editar. */
function LinhaDetail({ linha }: { linha: ProdutoLinha }) {
  return <ProdutosDaLinha linha={linha} />;
}

/** Drill-down dos Produtos da Linha + criacao de Produto com o schema da Linha.
 * Selecionar um Produto (clique na linha) abre, inline abaixo dele, a tabela de
 * precos com os SKUs daquele Produto. */
function ProdutosDaLinha({ linha }: { linha: ProdutoLinha }) {
  const router = useRouter();
  const produtos = useProdutos({ linha_id: linha.id });
  const atributos = useLinhaAtributos(linha.id);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = produtos.data?.items ?? [];
  // O ProdutoForm preenche os atributos definidos na Linha.
  const schema: AtributoSchema[] = (atributos.data?.items ?? []).map((a) => ({
    chave: a.chave,
    tipo: a.tipo,
    obrigatorio: a.obrigatorio,
    origem: "linha" as const,
  }));

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Produtos da linha</h3>
        <span className="count">{items.length}</span>
        {!creating ? (
          <button
            type="button"
            className="btn btn-sm btn-icon"
            style={{ marginLeft: "auto" }}
            onClick={() => setCreating(true)}
            aria-label="Novo produto"
            title="Novo produto"
          >
            <Plus aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {produtos.isLoading ? (
        <div style={{ display: "grid", gap: 8 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <span key={i} className="skel skel-line" style={{ width: "100%" }} />
          ))}
        </div>
      ) : produtos.isError ? (
        <div className="err-msg" style={{ display: "flex" }}>
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
                <th style={{ width: 150 }} aria-label="Status" />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const active = p.id === selectedId;
                return (
                <Fragment key={p.id}>
                <tr
                  className={active ? "clk active-row" : "clk"}
                  aria-selected={active}
                  onClick={() =>
                    setSelectedId((cur) => (cur === p.id ? null : p.id))
                  }
                  style={active ? { background: "var(--accent-soft)" } : undefined}
                >
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <StatusPill
                        state={p.ativo ? "ok" : "idle"}
                        label={p.ativo ? "Ativo" : "Inativo"}
                        iconOnly
                      />
                      <div className="cell-stack">
                        <b style={{ fontSize: "13.5px" }}>{p.nome}</b>
                        {p.disponibilidade ? (
                          <span className="sub">{p.disponibilidade}</span>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-end",
                      }}
                    >
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
                    <td colSpan={2} style={{ padding: 0, background: "var(--surface-2)" }}>
                      <TabelaPrecosLinha linhaId={linha.id} produtoId={p.id} embedded />
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
        <div style={{ marginTop: 16 }}>
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
  );
}
