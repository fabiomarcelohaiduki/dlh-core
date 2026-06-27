"use client";

import { useEffect, useState } from "react";
import type { TriagemItem } from "@/lib/api/types";
import { useFila } from "@/hooks/use-triagem";
import { TriagemTable } from "@/components/automacao/triagem-table";
import { WidgetError } from "@/components/cockpit/widget-error";

/**
 * cmp-fila-panel — Aba Fila: avisos aguardando triagem (ainda
 * sem veredito), em ordem FIFO (data_captura). Read-only: sem filtro e sem
 * acao (o veredito so e produzido pela esteira via LionClaw). Acumula as
 * paginas por avisoId; o `total` vem do servidor (fila inteira, nao a pagina).
 */
export function FilaPanel() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<TriagemItem[]>([]);
  // Busca por id do Effecti (server-side): debounce no input, reset da paginacao.
  const [idInput, setIdInput] = useState("");
  const [idFiltro, setIdFiltro] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setIdFiltro(idInput.trim()), 300);
    return () => clearTimeout(t);
  }, [idInput]);

  // Ao trocar a busca por id, zera as paginas acumuladas e o cursor (a query
  // muda no servidor; reaproveitar a lista antiga misturaria resultados).
  useEffect(() => {
    setItems([]);
    setCursor(undefined);
  }, [idFiltro]);

  const fila = useFila({ cursor, effecti: idFiltro || undefined });

  // Acumula as paginas carregadas, deduplicando por avisoId.
  useEffect(() => {
    const page = fila.data;
    if (!page) return;
    setItems((prev) => {
      const map = new Map(prev.map((i) => [i.avisoId, i]));
      for (const it of page.itens) map.set(it.avisoId, it);
      return Array.from(map.values());
    });
  }, [fila.data]);

  const total = fila.data?.total ?? null;
  const nextCursor = fila.data?.nextCursor ?? null;
  const loading = fila.isLoading && items.length === 0;

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Fila</h3>
        {!loading && !fila.isError && total !== null && (
          <span className="count">{total}</span>
        )}
      </div>

      <div className="filter-bar" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <input
          type="text"
          inputMode="numeric"
          placeholder="Buscar por id do Effecti"
          value={idInput}
          onChange={(e) => setIdInput(e.target.value)}
          aria-label="Buscar por id do Effecti"
          style={{ maxWidth: 220 }}
        />
      </div>

      {fila.isError ? (
        <WidgetError
          title="Não foi possível carregar"
          message="Não foi possível carregar a fila. Tente novamente."
          onRetry={() => fila.refetch()}
        />
      ) : (
        <TriagemTable
          variant="fila"
          loading={loading}
          items={items}
          emptyTitle="Fila vazia."
          emptyDescription="Nenhum aviso aguardando triagem. Avisos indexados e ainda sem veredito aparecem aqui."
          footer={
            nextCursor ? (
              <div className="tbl-foot">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={fila.isFetching}
                  onClick={() => setCursor(nextCursor)}
                >
                  Carregar mais
                </button>
              </div>
            ) : null
          }
        />
      )}
    </>
  );
}
