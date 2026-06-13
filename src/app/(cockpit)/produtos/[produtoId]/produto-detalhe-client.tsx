"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronLeft,
  Cpu,
  Loader2,
  PackageX,
  Pencil,
  Plus,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-react";
import { useProduto } from "@/hooks/use-produto";
import { useDeleteProduto } from "@/hooks/use-produtos";
import { useDeleteSku } from "@/hooks/use-skus";
import { ApiError } from "@/lib/api/client";
import { precoEstadoDescriptor } from "@/lib/status";
import { StatusPill } from "@/components/cockpit/status-pill";
import { ProdutoForm } from "@/components/cockpit/produtos/produto-form";
import { AtributosEditor } from "@/components/cockpit/produtos/atributos-editor";
import { SkuForm } from "@/components/cockpit/produtos/sku-form";
import { FotosUploader } from "@/components/cockpit/produtos/fotos-uploader";
import { PrecoRegionalGrid } from "@/components/cockpit/produtos/preco-regional-grid";
import { ApoioPrecosForm } from "@/components/cockpit/produtos/apoio-precos-form";
import { CriteriosPanel } from "@/components/cockpit/produtos/criterios-panel";
import type { AtributoSchema, ProdutoDetalhe, ProdutoSku } from "@/lib/api/types";

function BackToProdutos({ router }: { router: ReturnType<typeof useRouter> }) {
  return (
    <button
      type="button"
      className="link"
      style={{ fontSize: "12.5px", marginBottom: 8 }}
      onClick={() => router.push("/produtos")}
    >
      <ChevronLeft aria-hidden="true" />
      Voltar a Linhas &amp; Produtos
    </button>
  );
}

/**
 * Tela /produtos/[produtoId] (lado B do modulo): detalhe denso do Produto. Reune
 * os dados/atributos do Produto (schema herdado da Linha), as fotos, a sub-secao
 * de SKUs (com fotos, grid de precos calculados e indicadores de apoio por SKU)
 * e os criterios de cotacao no nivel do Produto. Estados loading/error travados.
 */
export function ProdutoDetalheClient({ produtoId }: { produtoId: string }) {
  const router = useRouter();
  const produto = useProduto(produtoId);

  if (produto.isLoading) {
    return (
      <section className="screen">
        <div className="page-head">
          <div className="titles">
            <BackToProdutos router={router} />
            <span className="skel skel-line" style={{ width: 280, height: 22 }} />
            <span className="skel skel-line" style={{ width: 360, marginTop: 8 }} />
          </div>
        </div>
        <div className="card">
          {Array.from({ length: 4 }).map((_, r) => (
            <span
              key={r}
              className="skel skel-line"
              style={{ display: "block", margin: "12px 0", width: `${55 + (r % 3) * 14}%` }}
            />
          ))}
        </div>
      </section>
    );
  }

  if (produto.isError || !produto.data) {
    const notFound =
      produto.error instanceof ApiError && produto.error.status === 404;
    return (
      <section className="screen">
        <div className="page-head">
          <div className="titles">
            <BackToProdutos router={router} />
            <h2>Detalhe do produto</h2>
          </div>
        </div>
        <div className="tbl-wrap">
          <div className="empty">
            <PackageX aria-hidden="true" style={{ color: "var(--err)" }} />
            <h4>Produto não encontrado / indisponível</h4>
            <p>
              {notFound
                ? "Não há produto com este identificador, ou ele não está mais disponível."
                : "Não foi possível carregar o detalhe do produto. Tente novamente em instantes."}
            </p>
            <div
              style={{ marginTop: 16, display: "flex", gap: 10, justifyContent: "center" }}
            >
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => router.push("/produtos")}
              >
                Voltar
              </button>
              {!notFound ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => produto.refetch()}
                >
                  Tentar novamente
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return <ProdutoDetalhe detalhe={produto.data} router={router} />;
}

function ProdutoDetalhe({
  detalhe,
  router,
}: {
  detalhe: ProdutoDetalhe;
  router: ReturnType<typeof useRouter>;
}) {
  const { produto, atributos_schema, skus } = detalhe;
  // Produto preenche os atributos da Linha; o SKU preenche o schema MESCLADO
  // (Linha + Produto), herdando os valores da Linha ja informados no Produto.
  const linhaSchema = atributos_schema.filter((a) => a.origem === "linha");
  const deleteProduto = useDeleteProduto();
  const [confirming, setConfirming] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function onConfirmDelete() {
    setErro(null);
    try {
      await deleteProduto.mutateAsync(produto.id);
      router.push("/produtos");
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 409
          ? "Produto possui vínculos (SKUs/preços) e não pode ser removido."
          : "Não foi possível excluir o produto. Tente novamente.",
      );
    }
  }

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <BackToProdutos router={router} />
          <h2 style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {produto.nome}
            <StatusPill
              state={produto.ativo ? "ok" : "idle"}
              label={produto.ativo ? "Ativo" : "Inativo"}
            />
          </h2>
          <p>
            Atributos herdados do schema da Linha, condições comerciais, fotos,
            SKUs e preços calculados.
          </p>
        </div>
        <div className="actions" style={{ alignItems: "center" }}>
          {confirming ? (
            <>
              <button
                type="button"
                className="btn btn-sm"
                style={{ color: "var(--err)" }}
                onClick={onConfirmDelete}
                disabled={deleteProduto.isPending}
              >
                {deleteProduto.isPending ? (
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
                disabled={deleteProduto.isPending}
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
              <span>Excluir produto</span>
            </button>
          )}
        </div>
      </div>
      {erro && (
        <div className="err-msg" style={{ display: "flex", marginBottom: 4 }}>
          <TriangleAlert aria-hidden="true" />
          {erro}
        </div>
      )}

      <ProdutoForm linhaId={produto.linha_id} schema={linhaSchema} produto={produto} />

      <div style={{ marginTop: 24 }}>
        <AtributosEditor scope="produto" produtoId={produto.id} linhaId={produto.linha_id} />
      </div>

      <SkusSection
        produtoId={produto.id}
        schema={atributos_schema}
        produtoAtributos={produto.atributos}
        skus={skus}
      />

      <div className="section-title">
        <h3>Critérios de cotação do Produto</h3>
        <span className="count">nível produto</span>
      </div>
      <CriteriosPanel nivel="produto" escopoId={produto.id} />
    </section>
  );
}

/** Sub-secao de SKUs: lista (master) com acoes na propria linha (editar/excluir
 * como icones a direita, no padrao da tela de Linhas) + detalhe + criacao. */
function SkusSection({
  produtoId,
  schema,
  produtoAtributos,
  skus,
}: {
  produtoId: string;
  schema: AtributoSchema[];
  produtoAtributos: Record<string, unknown>;
  skus: ProdutoSku[];
}) {
  const deleteSku = useDeleteSku();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const selected = skus.find((s) => s.id === selectedId) ?? null;

  async function onConfirmDelete(id: string) {
    setErro(null);
    try {
      await deleteSku.mutateAsync(id);
      setConfirmingId(null);
      if (selectedId === id) setSelectedId(null);
      if (editingId === id) setEditingId(null);
    } catch (err) {
      setConfirmingId(null);
      setErro(
        err instanceof ApiError && err.status === 409
          ? "SKU possui vínculos (composição/custo) e não pode ser removido."
          : "Não foi possível remover o SKU. Tente novamente.",
      );
    }
  }

  return (
    <>
      <div className="section-title">
        <h3>SKUs</h3>
        <span className="count">{skus.length}</span>
      </div>

      <div className="card">
        {skus.length === 0 ? (
          <div className="empty">
            <Cpu aria-hidden="true" />
            <h4>Nenhum SKU cadastrado</h4>
            <p>
              Cadastre variantes (fabricado ou comprado) para habilitar o cálculo
              de preço regional.
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Origem</th>
                  <th style={{ width: 110 }} aria-label="Ações" />
                </tr>
              </thead>
              <tbody>
                {skus.map((sku) => {
                  const desc = precoEstadoDescriptor(sku.estado_calculo);
                  const active = sku.id === selectedId;
                  const isConfirming = confirmingId === sku.id;
                  return (
                    <tr
                      key={sku.id}
                      className={active ? "clk active-row" : "clk"}
                      aria-selected={active}
                      style={active ? { background: "var(--accent-soft)" } : undefined}
                      onClick={() => {
                        setSelectedId(active ? null : sku.id);
                        setEditingId(null);
                        setCreating(false);
                      }}
                    >
                      <td className="mono">
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <StatusPill state={desc.state} label={desc.label} iconOnly />
                          {sku.codigo_sku}
                        </div>
                      </td>
                      <td className="sub">
                        {sku.tipo_origem === "fabricado" ? "Fabricado" : "Comprado"}
                      </td>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "flex-end",
                            gap: 8,
                          }}
                        >
                          {isConfirming ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon"
                                style={{ color: "var(--err)" }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onConfirmDelete(sku.id);
                                }}
                                disabled={deleteSku.isPending}
                                aria-label="Confirmar exclusão"
                                title="Confirmar exclusão"
                              >
                                {deleteSku.isPending ? (
                                  <Loader2 className="spin" aria-hidden="true" />
                                ) : (
                                  <Check aria-hidden="true" />
                                )}
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmingId(null);
                                }}
                                disabled={deleteSku.isPending}
                                aria-label="Cancelar"
                                title="Cancelar"
                              >
                                <X aria-hidden="true" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon"
                                style={{ color: "var(--accent)" }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedId(sku.id);
                                  setEditingId(sku.id);
                                  setCreating(false);
                                  setErro(null);
                                }}
                                aria-label="Editar SKU"
                                title="Editar"
                              >
                                <Pencil aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmingId(sku.id);
                                  setErro(null);
                                }}
                                aria-label="Excluir SKU"
                                title="Excluir"
                              >
                                <Trash2 aria-hidden="true" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {erro && (
          <div className="err-msg" style={{ display: "flex", marginTop: 14 }}>
            <TriangleAlert aria-hidden="true" />
            {erro}
          </div>
        )}

        {creating ? (
          <div style={{ marginTop: 16 }}>
            <SkuForm
              produtoId={produtoId}
              schema={schema}
              produtoAtributos={produtoAtributos}
              onSuccess={(sku) => {
                setCreating(false);
                setSelectedId(sku.id);
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        ) : (
          <div className="form-foot" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setCreating(true);
                setSelectedId(null);
                setEditingId(null);
              }}
            >
              <Plus aria-hidden="true" />
              <span>Novo SKU</span>
            </button>
          </div>
        )}
      </div>

      {selected && (
        <SkuDetail
          key={selected.id}
          sku={selected}
          schema={schema}
          produtoAtributos={produtoAtributos}
          editing={editingId === selected.id}
          onEditEnd={() => setEditingId(null)}
        />
      )}
    </>
  );
}

/** Detalhe do SKU selecionado: edicao inline (controlada pela linha), fotos,
 * grid de precos e apoio. Identidade e acoes vivem na linha da tabela acima. */
function SkuDetail({
  sku,
  schema,
  produtoAtributos,
  editing,
  onEditEnd,
}: {
  sku: ProdutoSku;
  schema: AtributoSchema[];
  produtoAtributos: Record<string, unknown>;
  editing: boolean;
  onEditEnd: () => void;
}) {
  return (
    <div style={{ display: "grid", gap: 16, marginTop: 4 }}>
      {editing && (
        <SkuForm
          produtoId={sku.produto_id}
          schema={schema}
          produtoAtributos={produtoAtributos}
          sku={sku}
          onSuccess={onEditEnd}
          onCancel={onEditEnd}
        />
      )}

      <PrecoRegionalGrid skuId={sku.id} produtoId={sku.produto_id} />
      <ApoioPrecosForm skuId={sku.id} />

      <FotosUploader skuId={sku.id} />
    </div>
  );
}
