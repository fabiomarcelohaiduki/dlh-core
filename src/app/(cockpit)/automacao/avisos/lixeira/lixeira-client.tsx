"use client";

import { useEffect, useState } from "react";
import type { LixeiraItem } from "@/lib/api/types";
import { useTriagemLixeira } from "@/hooks/use-triagem-lixeira";
import { LixeiraTable } from "@/components/automacao/lixeira-table";
import { ModoSombraBanner } from "@/components/automacao/modo-sombra-banner";
import { WidgetError } from "@/components/cockpit/widget-error";

/**
 * LixeiraClient — aba Lixeira. Avisos em carencia (na_lixeira=true) com a data
 * prevista de descarte e o banner persistente de modo sombra/ligado. Paginacao
 * por cursor com footer "Carregar mais" (acumula por avisoId).
 */
export function LixeiraClient() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<LixeiraItem[]>([]);

  const lixeira = useTriagemLixeira({ cursor });

  // Acumula as paginas, deduplicando por avisoId; o refetch leve da pagina
  // corrente apenas atualiza os itens ja presentes.
  useEffect(() => {
    const page = lixeira.data;
    if (!page) return;
    setItems((prev) => {
      const map = new Map(prev.map((i) => [i.avisoId, i]));
      for (const it of page.itens) map.set(it.avisoId, it);
      return Array.from(map.values());
    });
  }, [lixeira.data]);

  const nextCursor = lixeira.data?.nextCursor ?? null;
  const loading = lixeira.isLoading && items.length === 0;
  // Default modo sombra: na ausencia de dados, assume desligado (false).
  const descarteFisicoLigado = lixeira.data?.descarteFisicoLigado ?? false;

  return (
    <>
      <ModoSombraBanner ligado={descarteFisicoLigado} />

      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Lixeira</h3>
        {!loading && !lixeira.isError && (
          <span className="count">{items.length}</span>
        )}
      </div>

      {lixeira.isError ? (
        <WidgetError
          title="Não foi possível carregar"
          message="Não foi possível carregar. Tente novamente."
          onRetry={() => lixeira.refetch()}
        />
      ) : (
        <LixeiraTable
          loading={loading}
          items={items}
          emptyTitle="A lixeira está vazia."
          emptyDescription="Nenhum aviso na carência aguardando descarte."
          footer={
            nextCursor ? (
              <div className="tbl-foot">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={lixeira.isFetching}
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
