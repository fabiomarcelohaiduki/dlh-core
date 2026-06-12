"use client";

import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/cockpit/status-pill";
import { useRecalcularSku } from "@/hooks/use-recalcular-sku";
import { usePrecosCalculados } from "@/hooks/use-precos-calculados";
import { precoEstadoDescriptor } from "@/lib/status";
import { formatCurrency, formatDateTimeFull } from "@/lib/format";
import type { Patamar, PrecoCalculadoLinha, Regiao } from "@/lib/api/types";

const REGIOES: { value: Regiao; label: string }[] = [
  { value: "S", label: "Sul" },
  { value: "SE", label: "Sudeste" },
  { value: "CO", label: "Centro-Oeste" },
  { value: "NE", label: "Nordeste" },
  { value: "N", label: "Norte" },
];

const PATAMARES: { value: Patamar; hint: string }[] = [
  { value: "CIF", hint: "com frete" },
  { value: "FOB", hint: "sem frete" },
];

/** Indexa o grid por `regiao-patamar` para leitura O(1) das celulas. */
function indexPrecos(linhas: PrecoCalculadoLinha[]) {
  const map = new Map<string, PrecoCalculadoLinha>();
  for (const linha of linhas) map.set(`${linha.regiao}-${linha.patamar}`, linha);
  return map;
}

/**
 * cmp-preco-regional-grid — grid (5 regioes x CIF/FOB) dos precos calculados de
 * um SKU (RF-23). O estado_calculo agregado vira pill via precoEstadoDescriptor
 * (vigente=ok, pendente=warn, erro=err) e, durante o recalculo, vai para 'run'.
 * valor e custo_base sao exclusivos do motor (somente leitura); 'Recalcular' so
 * aparece quando pendente/erro e, ao concluir, invalida grid e fila de pendentes.
 */
export function PrecoRegionalGrid({ skuId }: { skuId: string }) {
  const precos = usePrecosCalculados(skuId);
  const recalcular = useRecalcularSku();

  const data = precos.data;
  const cells = data ? indexPrecos(data.precos) : null;

  // Pill agregado: durante o recalculo, sobrepoe para 'run'.
  const estado = data?.estado_calculo ?? "pendente";
  const descriptor = recalcular.isPending
    ? { state: "run" as const, label: "Recalculando…" }
    : precoEstadoDescriptor(estado);
  const canRecalcular = estado === "pendente" || estado === "erro";

  const lastCalculo =
    data?.precos
      .map((p) => p.calculado_em)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? null;

  return (
    <div className="card">
      <div className="section-title" style={{ margin: "0 0 14px" }}>
        <h3>Preço calculado</h3>
        {!precos.isLoading && !precos.isError && (
          <StatusPill state={descriptor.state} label={descriptor.label} />
        )}
      </div>

      {precos.isLoading ? (
        <div style={{ display: "grid", gap: 8 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <span key={i} className="skel skel-line" style={{ width: "100%" }} />
          ))}
        </div>
      ) : precos.isError ? (
        <div className="err-msg" style={{ display: "flex" }}>
          <TriangleAlert aria-hidden="true" />
          Não foi possível carregar os preços deste SKU.
        </div>
      ) : !data || data.precos.length === 0 ? (
        <div className="empty">
          <RefreshCw aria-hidden="true" />
          <h4>Sem preços calculados</h4>
          <p>
            O motor ainda não gerou o grid deste SKU. Use “Recalcular” após
            definir composição, custos e parâmetros.
          </p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Região</th>
                {PATAMARES.map((p) => (
                  <th key={p.value} style={{ textAlign: "right" }}>
                    {p.value}{" "}
                    <span className="sub" style={{ fontWeight: 400 }}>
                      ({p.hint})
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {REGIOES.map((regiao) => (
                <tr key={regiao.value}>
                  <td>
                    <span className="mono">{regiao.value}</span>
                    <span className="sub" style={{ marginLeft: 8 }}>
                      {regiao.label}
                    </span>
                  </td>
                  {PATAMARES.map((patamar) => {
                    const cell = cells?.get(`${regiao.value}-${patamar.value}`);
                    const cellDescriptor = cell
                      ? precoEstadoDescriptor(cell.estado)
                      : null;
                    return (
                      <td key={patamar.value} style={{ textAlign: "right" }}>
                        {cell && cell.estado === "vigente" ? (
                          <span className="tnum">{formatCurrency(cell.valor)}</span>
                        ) : cellDescriptor ? (
                          <StatusPill
                            state={cellDescriptor.state}
                            label={cellDescriptor.label}
                          />
                        ) : (
                          <span style={{ color: "var(--faint)" }}>—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!precos.isLoading && !precos.isError && data && (
        <div
          className="form-foot"
          style={{ marginTop: 14, justifyContent: "space-between" }}
        >
          <span style={{ color: "var(--faint)", fontSize: "12.5px" }}>
            Custo base{" "}
            <span className="tnum">{formatCurrency(data.custo_base)}</span>
            {lastCalculo ? ` · calculado em ${formatDateTimeFull(lastCalculo)}` : ""}
          </span>
          {canRecalcular && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => recalcular.mutate(skuId)}
              disabled={recalcular.isPending}
            >
              {recalcular.isPending ? (
                <Loader2 className="spin" aria-hidden="true" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              <span>Recalcular</span>
            </button>
          )}
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
