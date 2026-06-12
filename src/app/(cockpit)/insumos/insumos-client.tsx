"use client";

import { useMemo, useState } from "react";
import {
  Cpu,
  Loader2,
  Package,
  Pencil,
  Plus,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-react";
import { useDeleteInsumo, useInsumos } from "@/hooks/use-insumos";
import { useProdutos } from "@/hooks/use-produtos";
import { useProduto } from "@/hooks/use-produto";
import { ApiError } from "@/lib/api/client";
import { StatusPill } from "@/components/cockpit/status-pill";
import {
  InsumosTable,
  categoriaLabel,
} from "@/components/cockpit/produtos/insumos-table";
import { InsumoForm } from "@/components/cockpit/produtos/insumo-form";
import { InsumoPrecosLoteForm } from "@/components/cockpit/produtos/insumo-precos-lote-form";
import { ComposicaoEditor } from "@/components/cockpit/produtos/composicao-editor";
import { CustoAquisicaoForm } from "@/components/cockpit/produtos/custo-aquisicao-form";
import type { Insumo } from "@/lib/api/types";

type FormMode = "none" | "new" | "edit";

/**
 * Tela /insumos: dois blocos. (1) Catálogo de insumos (master-detail): lista os
 * insumos e, ao selecionar, abre os preços de fornecedor com vigência e edição
 * em lote. (2) Custo dos SKUs: escolhe um Produto e um SKU e abre a composição
 * (BOM, fabricado) ou o custo de aquisição (comprado), conforme tipo_origem.
 */
export function InsumosClient() {
  const insumos = useInsumos({ limit: 500 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<FormMode>("none");

  const items = useMemo(() => insumos.data?.items ?? [], [insumos.data]);
  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  function onSelect(insumo: Insumo) {
    setSelectedId(insumo.id);
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
          <h2>Insumos &amp; Preços</h2>
          <p>
            Cadastre insumos e mantenha os preços de fornecedor com vigência.
            Abaixo, monte a composição (BOM) dos SKUs fabricados ou o custo de
            aquisição dos comprados — toda escrita recalcula os preços afetados.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <Plus aria-hidden="true" />
            <span>Novo insumo</span>
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(280px, 380px) 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <InsumosTable
          insumos={items}
          loading={insumos.isLoading}
          isError={insumos.isError}
          onRetry={() => insumos.refetch()}
          selectedId={selectedId}
          onSelect={onSelect}
          onNew={onNew}
        />

        <div style={{ display: "grid", gap: 16 }}>
          {formMode === "new" ? (
            <InsumoForm
              onSuccess={(insumo) => {
                setSelectedId(insumo.id);
                setFormMode("none");
              }}
              onCancel={() => setFormMode("none")}
            />
          ) : formMode === "edit" && selected ? (
            <InsumoForm
              insumo={selected}
              onSuccess={() => setFormMode("none")}
              onCancel={() => setFormMode("none")}
            />
          ) : selected ? (
            <InsumoDetail
              insumo={selected}
              onEdit={() => setFormMode("edit")}
              onDeleted={() => setSelectedId(null)}
            />
          ) : (
            <div className="card">
              <div className="empty">
                <Package aria-hidden="true" />
                <h4>Selecione um insumo</h4>
                <p>
                  Escolha um insumo à esquerda para ver e editar os preços de
                  fornecedor — ou cadastre um novo.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="section-title">
        <h3>Custo dos SKUs</h3>
        <span className="count">composição / aquisição</span>
      </div>
      <SkuCustoSection />
    </section>
  );
}

/** Painel DETAIL de um insumo: cabecalho + acoes + precos de fornecedor. */
function InsumoDetail({
  insumo,
  onEdit,
  onDeleted,
}: {
  insumo: Insumo;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const deleteInsumo = useDeleteInsumo();
  const [confirming, setConfirming] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function onConfirmDelete() {
    setErro(null);
    try {
      await deleteInsumo.mutateAsync(insumo.id);
      setConfirming(false);
      onDeleted();
    } catch (err) {
      setErro(
        err instanceof ApiError && err.status === 409
          ? "Insumo referenciado em composição. Desative-o (ativo = não) em vez de excluir."
          : "Não foi possível excluir o insumo. Tente novamente.",
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
              <strong style={{ fontSize: "15px" }}>{insumo.nome}</strong>
              <StatusPill
                state={insumo.ativo ? "ok" : "idle"}
                label={insumo.ativo ? "Ativo" : "Inativo"}
              />
            </div>
            <p style={{ margin: 0, fontSize: "12.5px", color: "var(--muted)" }}>
              {categoriaLabel(insumo.categoria)} · unidade{" "}
              <span className="mono">{insumo.unidade}</span>
            </p>
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
                  disabled={deleteInsumo.isPending}
                >
                  {deleteInsumo.isPending ? (
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
                  disabled={deleteInsumo.isPending}
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

      <InsumoPrecosLoteForm insumo={insumo} />
    </>
  );
}

/** Bloco de custo por SKU: escolhe Produto -> SKU e abre BOM ou aquisicao. */
function SkuCustoSection() {
  const produtos = useProdutos({ limit: 500 });
  const [produtoId, setProdutoId] = useState("");
  const [skuId, setSkuId] = useState("");

  const detalhe = useProduto(produtoId || undefined, {
    enabled: Boolean(produtoId),
  });
  const skus = detalhe.data?.skus ?? [];
  const sku = skus.find((s) => s.id === skuId) ?? null;

  const produtoItems = produtos.data?.items ?? [];

  return (
    <div className="card">
      <p style={{ margin: "0 0 14px", fontSize: "12.5px", color: "var(--muted)" }}>
        Selecione um Produto e um SKU. A composição (BOM) aparece para SKU
        fabricado; o custo de aquisição, para SKU comprado.
      </p>

      <div className="grid-fields" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="sku-produto">Produto</label>
          <select
            id="sku-produto"
            value={produtoId}
            onChange={(e) => {
              setProdutoId(e.target.value);
              setSkuId("");
            }}
            disabled={produtos.isLoading}
          >
            <option value="">Selecione um produto…</option>
            {produtoItems.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="sku-sku">SKU</label>
          <select
            id="sku-sku"
            value={skuId}
            onChange={(e) => setSkuId(e.target.value)}
            disabled={!produtoId || detalhe.isLoading || skus.length === 0}
          >
            <option value="">
              {!produtoId
                ? "Escolha um produto primeiro"
                : detalhe.isLoading
                  ? "Carregando…"
                  : skus.length === 0
                    ? "Nenhum SKU neste produto"
                    : "Selecione um SKU…"}
            </option>
            {skus.map((s) => (
              <option key={s.id} value={s.id}>
                {s.codigo_sku} ({s.tipo_origem === "fabricado" ? "fabricado" : "comprado"})
              </option>
            ))}
          </select>
        </div>
      </div>

      {sku ? (
        <div style={{ marginTop: 16, display: "grid", gap: 16 }}>
          {sku.tipo_origem === "fabricado" ? (
            <ComposicaoEditor skuId={sku.id} />
          ) : (
            <CustoAquisicaoForm skuId={sku.id} />
          )}
        </div>
      ) : (
        <div className="empty" style={{ paddingTop: 36, paddingBottom: 16 }}>
          <Cpu aria-hidden="true" />
          <h4>Nenhum SKU selecionado</h4>
          <p>Escolha um Produto e um SKU acima para editar custo de produção ou de aquisição.</p>
        </div>
      )}
    </div>
  );
}
