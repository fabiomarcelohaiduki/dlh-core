"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  Layers,
  Loader2,
  Package,
  Pencil,
  Plus,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-react";
import { useDeleteLinha, useLinhas } from "@/hooks/use-linhas";
import { useLinhaAtributos } from "@/hooks/use-linha-atributos";
import { useProdutos } from "@/hooks/use-produtos";
import { ApiError } from "@/lib/api/client";
import { StatusPill } from "@/components/cockpit/status-pill";
import { LinhasTable } from "@/components/cockpit/produtos/linhas-table";
import { LinhaForm } from "@/components/cockpit/produtos/linha-form";
import { AtributosEditor } from "@/components/cockpit/produtos/atributos-editor";
import { CriteriosPanel } from "@/components/cockpit/produtos/criterios-panel";
import { ProdutoForm } from "@/components/cockpit/produtos/produto-form";
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
        <div className="titles">
          <h2>Linhas &amp; Produtos</h2>
          <p>
            As Linhas agrupam Produtos e definem os atributos que cada Produto
            preenche. Selecione uma Linha para editar seus atributos, critérios
            de cotação e abrir os Produtos vinculados.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <Plus aria-hidden="true" />
            <span>Nova linha</span>
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 340px) 1fr",
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
            <LinhaForm
              linha={selected}
              onSuccess={() => setFormMode("none")}
              onCancel={() => setFormMode("none")}
            />
          ) : selected ? (
            <LinhaDetail
              linha={selected}
              onEdit={() => setFormMode("edit")}
              onDeleted={() => setSelectedId(null)}
            />
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

/** Painel DETAIL de uma Linha: cabecalho + atributos + produtos + criterios. */
function LinhaDetail({
  linha,
  onEdit,
  onDeleted,
}: {
  linha: ProdutoLinha;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const deleteLinha = useDeleteLinha();
  const [confirming, setConfirming] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const ativo = linha.ativo
    ? ({ state: "ok", label: "Ativa" } as const)
    : ({ state: "idle", label: "Inativa" } as const);

  async function onConfirmDelete() {
    setErro(null);
    try {
      await deleteLinha.mutateAsync(linha.id);
      setConfirming(false);
      onDeleted();
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 409
          ? "Linha possui produtos vinculados. Remova os Produtos antes de excluir a Linha."
          : "Não foi possível excluir a linha. Tente novamente.",
      );
    }
  }

  return (
    <>
      <div className="card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <strong style={{ fontSize: "15px" }}>{linha.nome}</strong>
              <StatusPill state={ativo.state} label={ativo.label} />
            </div>
            {linha.descricao ? (
              <p style={{ margin: 0, fontSize: "12.5px", color: "var(--muted)" }}>
                {linha.descricao}
              </p>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" className="btn btn-sm" onClick={onEdit}>
              <Pencil aria-hidden="true" />
              <span>Editar</span>
            </button>
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
                  <span>Confirmar</span>
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
                <span>Excluir</span>
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

      <AtributosEditor linhaId={linha.id} />

      <ProdutosDaLinha linha={linha} />

      <div className="section-title">
        <h3>Critérios de cotação da Linha</h3>
        <span className="count">nível linha</span>
      </div>
      <CriteriosPanel nivel="linha" escopoId={linha.id} />
    </>
  );
}

/** Drill-down dos Produtos da Linha + criacao de Produto com o schema da Linha. */
function ProdutosDaLinha({ linha }: { linha: ProdutoLinha }) {
  const router = useRouter();
  const produtos = useProdutos({ linha_id: linha.id });
  const atributos = useLinhaAtributos(linha.id);
  const [creating, setCreating] = useState(false);

  const items = produtos.data?.items ?? [];
  const schema: AtributoSchema[] = (atributos.data?.items ?? []).map((a) => ({
    chave: a.chave,
    tipo: a.tipo,
    obrigatorio: a.obrigatorio,
  }));

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Produtos da linha</h3>
        <span className="count">{items.length}</span>
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
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Produto</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr
                  key={p.id}
                  className="clk"
                  onClick={() => router.push(`/produtos/${p.id}`)}
                >
                  <td>
                    <div className="cell-stack">
                      <b style={{ fontSize: "13.5px" }}>{p.nome}</b>
                      {p.disponibilidade ? (
                        <span className="sub">{p.disponibilidade}</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <StatusPill
                      state={p.ativo ? "ok" : "idle"}
                      label={p.ativo ? "Ativo" : "Inativo"}
                    />
                  </td>
                  <td>
                    <Link
                      href={`/produtos/${p.id}`}
                      className="link"
                      aria-label={`Abrir ${p.nome}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ChevronRight aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              ))}
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
      ) : (
        <div className="form-foot" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreating(true)}
          >
            <Plus aria-hidden="true" />
            <span>Novo produto</span>
          </button>
        </div>
      )}
    </div>
  );
}
