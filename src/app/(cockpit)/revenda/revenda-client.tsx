"use client";

import { useMemo, useState } from "react";
import { Pencil, Plus, Store } from "lucide-react";
import { useClientesRevenda } from "@/hooks/use-revenda";
import { StatusPill } from "@/components/cockpit/status-pill";
import { ClientesRevendaTable } from "@/components/cockpit/produtos/clientes-revenda-table";
import { ClienteRevendaForm } from "@/components/cockpit/produtos/cliente-revenda-form";
import { RevendaPrecosForm } from "@/components/cockpit/produtos/revenda-precos-form";
import type { ClienteRevenda } from "@/lib/api/types";

type FormMode = "none" | "new" | "edit";

/**
 * Tela /revenda (master-detail): o MASTER lista os clientes do canal de revenda
 * (ativo/inativo) e o DETAIL, ao selecionar, abre a tabela de precos por
 * cliente/SKU com vigencia/historico. O canal de revenda e SEPARADO do preco de
 * licitacao. Estados loading/error/empty travados pelo Design Lock.
 */
export function RevendaClient() {
  const clientes = useClientesRevenda({ limit: 500 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<FormMode>("none");

  const items = useMemo(() => clientes.data?.items ?? [], [clientes.data]);
  const selected = useMemo(
    () => items.find((c) => c.id === selectedId) ?? null,
    [items, selectedId],
  );

  function onSelect(cliente: ClienteRevenda) {
    setSelectedId(cliente.id);
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
          <h2>Revenda</h2>
          <p>
            Clientes do canal de revenda e suas tabelas de preço por SKU, com
            vigência e histórico. Este canal é separado do preço de licitação.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <Plus aria-hidden="true" />
            <span>Novo cliente</span>
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 360px) 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <ClientesRevendaTable
          clientes={items}
          loading={clientes.isLoading}
          isError={clientes.isError}
          onRetry={() => clientes.refetch()}
          selectedId={selectedId}
          onSelect={onSelect}
          onNew={onNew}
        />

        <div style={{ display: "grid", gap: 16 }}>
          {formMode === "new" ? (
            <ClienteRevendaForm
              onSuccess={(cliente) => {
                setSelectedId(cliente.id);
                setFormMode("none");
              }}
              onCancel={() => setFormMode("none")}
            />
          ) : formMode === "edit" && selected ? (
            <ClienteRevendaForm
              cliente={selected}
              onSuccess={() => setFormMode("none")}
              onCancel={() => setFormMode("none")}
            />
          ) : selected ? (
            <ClienteDetail cliente={selected} onEdit={() => setFormMode("edit")} />
          ) : (
            <div className="card">
              <div className="empty">
                <Store aria-hidden="true" />
                <h4>Selecione um cliente</h4>
                <p>
                  Escolha um cliente de revenda à esquerda para editar a tabela
                  de preços por SKU — ou cadastre um novo.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Painel DETAIL de um cliente: cabecalho + acoes + tabela de precos por SKU. */
function ClienteDetail({
  cliente,
  onEdit,
}: {
  cliente: ClienteRevenda;
  onEdit: () => void;
}) {
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
              <strong style={{ fontSize: "15px" }}>{cliente.nome}</strong>
              <StatusPill
                state={cliente.ativo ? "ok" : "idle"}
                label={cliente.ativo ? "Ativo" : "Inativo"}
              />
            </div>
            <p style={{ margin: 0, fontSize: "12.5px", color: "var(--muted)" }}>
              Cliente do canal de revenda.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" className="btn btn-sm" onClick={onEdit}>
              <Pencil aria-hidden="true" />
              <span>Editar</span>
            </button>
          </div>
        </div>
      </div>

      <RevendaPrecosForm clienteId={cliente.id} />
    </>
  );
}
