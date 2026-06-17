"use client";

import { useMemo, useState } from "react";
import { Cpu, Package } from "lucide-react";
import { useDeleteInsumo, useInsumos } from "@/hooks/use-insumos";
import { useProdutos } from "@/hooks/use-produtos";
import { useProduto } from "@/hooks/use-produto";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { InsumosTable } from "@/components/cockpit/produtos/insumos-table";
import { InsumoForm } from "@/components/cockpit/produtos/insumo-form";
import { InsumoPrecosLoteForm } from "@/components/cockpit/produtos/insumo-precos-lote-form";
import { ComposicaoEditor } from "@/components/cockpit/produtos/composicao-editor";
import { CustoAquisicaoForm } from "@/components/cockpit/produtos/custo-aquisicao-form";
import type { Insumo } from "@/lib/api/types";

type FormMode = "none" | "new" | "edit";
type Aba = "insumos" | "custo";

/**
 * Tela /insumos: duas abas. (1) Insumos & Preços (master-detail): lista os
 * insumos com busca por nome e, ao selecionar, abre os preços de fornecedor com
 * vigência e edição em lote. (2) Custo dos SKUs: escolhe um Produto e um SKU e
 * abre a composição (BOM, fabricado) ou o custo de aquisição (comprado),
 * conforme tipo_origem. As abas separam as duas tarefas para a lista de insumos
 * crescer sem enterrar o bloco de custo.
 */
export function InsumosClient() {
  const insumos = useInsumos({ limit: 500 });
  const [aba, setAba] = useState<Aba>("insumos");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<FormMode>("none");
  const [busca, setBusca] = useState("");

  const items = useMemo(() => insumos.data?.items ?? [], [insumos.data]);
  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.nome.toLowerCase().includes(q));
  }, [items, busca]);
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
      <div
        className="filter-group segmented"
        role="tablist"
        aria-label="Seção"
        style={{ display: "inline-flex", margin: "0 0 16px" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={aba === "insumos"}
          className={cn("btn", "btn-sm", aba === "insumos" && "btn-primary")}
          onClick={() => setAba("insumos")}
        >
          Cadastro
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === "custo"}
          className={cn("btn", "btn-sm", aba === "custo" && "btn-primary")}
          onClick={() => setAba("custo")}
        >
          Composição & custo
        </button>
      </div>

      {aba === "insumos" ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(300px, 400px) 1fr",
            gap: 16,
            alignItems: "start",
          }}
        >
          <InsumosTable
            insumos={filtrados}
            totalCadastrados={items.length}
            busca={busca}
            onBuscaChange={setBusca}
            loading={insumos.isLoading}
            isError={insumos.isError}
            onRetry={() => insumos.refetch()}
            selectedId={selectedId}
            onSelect={onSelect}
            onNew={onNew}
            onEdit={(insumo) => {
              setSelectedId(insumo.id);
              setFormMode("edit");
            }}
          />

          <div style={{ display: "grid", gap: 16, minWidth: 0, gridTemplateColumns: "minmax(0, 1fr)" }}>
            {formMode === "new" ? (
              <InsumoForm
                onSuccess={(insumo) => {
                  setSelectedId(insumo.id);
                  setFormMode("none");
                }}
                onCancel={() => setFormMode("none")}
              />
            ) : formMode === "edit" && selected ? (
              <InsumoEditPanel
                insumo={selected}
                onExit={() => setFormMode("none")}
                onDeleted={() => {
                  setSelectedId(null);
                  setFormMode("none");
                }}
              />
            ) : selected ? (
              <InsumoDetail insumo={selected} />
            ) : (
              <div className="card">
                <div className="empty">
                  <Package aria-hidden="true" />
                  <h4>Selecione um material</h4>
                  <p>
                    Escolha um material à esquerda para ver e editar os preços de
                    fornecedor — ou cadastre um novo.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <SkuCustoSection />
      )}
    </section>
  );
}

/** Painel DETAIL de um insumo: precos de fornecedor. A edicao e a exclusao
 * vivem no editar (aberto pelo simbolo laranja da lista). */
function InsumoDetail({ insumo }: { insumo: Insumo }) {
  return <InsumoPrecosLoteForm insumo={insumo} />;
}

/** Painel de EDICAO de um insumo: form + exclusao (o excluir vive dentro do
 * editar; a lista a esquerda so abre via simbolo laranja). */
function InsumoEditPanel({
  insumo,
  onExit,
  onDeleted,
}: {
  insumo: Insumo;
  onExit: () => void;
  onDeleted: () => void;
}) {
  const deleteInsumo = useDeleteInsumo();
  const [erro, setErro] = useState<string | null>(null);

  async function onConfirmDelete() {
    setErro(null);
    try {
      await deleteInsumo.mutateAsync(insumo.id);
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
    <InsumoForm
      insumo={insumo}
      onSuccess={onExit}
      onCancel={onExit}
      onDelete={onConfirmDelete}
      deleting={deleteInsumo.isPending}
      deleteError={erro}
    />
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
