"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  Layers,
  Package,
  Plus,
  TriangleAlert,
  Wand2,
} from "lucide-react";
import { useLinhas } from "@/hooks/use-linhas";
import { useLinhaAtributos } from "@/hooks/use-linha-atributos";
import { useProdutos } from "@/hooks/use-produtos";
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
          onEdit={(linha) => {
            setSelectedId(linha.id);
            setFormMode("edit");
          }}
          onDeleted={() => {
            setSelectedId(null);
            setFormMode("none");
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
            <>
              <LinhaForm
                linha={selected}
                onSuccess={() => setFormMode("none")}
                onCancel={() => setFormMode("none")}
              />
              <AtributosEditor linhaId={selected.id} />
            </>
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

/** Painel DETAIL de uma Linha: produtos + tabela de precos + criterios. A
 * identidade e as acoes (Editar/Excluir) da Linha vivem na lista a esquerda. */
function LinhaDetail({ linha }: { linha: ProdutoLinha }) {
  return (
    <>
      <ProdutosDaLinha linha={linha} />

      <TabelaPrecosLinha linhaId={linha.id} />

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
