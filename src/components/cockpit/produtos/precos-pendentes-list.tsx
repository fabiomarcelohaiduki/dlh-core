"use client";

import { CheckCircle2, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { usePrecosPendentes } from "@/hooks/use-precos-pendentes";
import { useRecalcularSku } from "@/hooks/use-recalcular-sku";
import { StatusPill } from "@/components/cockpit/status-pill";
import { precoEstadoDescriptor } from "@/lib/status";

/**
 * cmp-precos-pendentes-list — fila de SKUs com estado_calculo pendente/erro
 * (GET /precos/pendentes). Cada item traz o codigo_sku, o status-pill do estado
 * e um atalho de recalculo manual (use-recalcular-sku); ao concluir, o SKU sai
 * da fila (o hook invalida a lista). Estado vazio quando nao ha pendentes.
 * Poll leve para refletir SKUs marcados por escritas de insumos/parametros.
 */
export function PrecosPendentesList() {
  const pendentes = usePrecosPendentes({ refetchInterval: 15000 });
  const recalcular = useRecalcularSku();

  const items = pendentes.data?.items ?? [];

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Pendentes de recálculo</h3>
        {!pendentes.isLoading && !pendentes.isError && (
          <span className="count">{items.length}</span>
        )}
      </div>

      {pendentes.isLoading ? (
        <div style={{ display: "grid", gap: 8 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <span key={i} className="skel skel-line" style={{ width: "100%" }} />
          ))}
        </div>
      ) : pendentes.isError ? (
        <div className="empty">
          <TriangleAlert aria-hidden="true" style={{ color: "var(--err)" }} />
          <h4>Não foi possível carregar a fila</h4>
          <p>Tente novamente em instantes.</p>
          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-sm" onClick={() => pendentes.refetch()}>
              Tentar novamente
            </button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <CheckCircle2 aria-hidden="true" style={{ color: "var(--ok)" }} />
          <h4>Nenhum SKU pendente</h4>
          <p>Todos os preços estão vigentes. Alterações de custo aparecem aqui.</p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th style={{ width: 120 }}>Estado</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((sku) => {
                const desc = precoEstadoDescriptor(sku.estado_calculo);
                const recalculandoEste =
                  recalcular.isPending && recalcular.variables === sku.sku_id;
                return (
                  <tr key={sku.sku_id}>
                    <td className="mono">{sku.codigo_sku}</td>
                    <td>
                      <StatusPill state={desc.state} label={desc.label} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => recalcular.mutate(sku.sku_id)}
                        disabled={recalcular.isPending}
                      >
                        {recalculandoEste ? (
                          <Loader2 className="spin" aria-hidden="true" />
                        ) : (
                          <RefreshCw aria-hidden="true" />
                        )}
                        <span>Recalcular</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {recalcular.isError && (
        <div className="err-msg" style={{ display: "flex", marginTop: 12 }}>
          <TriangleAlert aria-hidden="true" />
          Não foi possível recalcular agora. Tente novamente.
        </div>
      )}
    </div>
  );
}
