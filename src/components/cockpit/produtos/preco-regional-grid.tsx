"use client";

import type { CSSProperties } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/cockpit/status-pill";
import { useRecalcularSku } from "@/hooks/use-recalcular-sku";
import { usePrecosCalculados } from "@/hooks/use-precos-calculados";
import { useParametrosResolvidos } from "@/hooks/use-parametros-resolvidos";
import { precoEstadoDescriptor } from "@/lib/status";
import { formatCurrency, formatDateTimeFull } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  ParametroEscalarCampo,
  ParametroNivel,
  Patamar,
  PrecoCalculadoLinha,
  Regiao,
} from "@/lib/api/types";

const REGIOES: { value: Regiao; label: string }[] = [
  { value: "S", label: "Sul" },
  { value: "SE", label: "Sudeste" },
  { value: "CO", label: "Centro-Oeste" },
  { value: "NE", label: "Nordeste" },
  { value: "N", label: "Norte" },
];

/** Os 3 patamares do metodo IFP, na ordem da planilha (mais barato -> alvo). */
const PATAMARES: { value: Patamar; label: string; hint: string }[] = [
  { value: "FOB", label: "FOB", hint: "sem frete" },
  { value: "CIF_MINIMO", label: "CIF Mínimo", hint: "piso de negociação" },
  { value: "CIF_ALVO", label: "CIF Alvo", hint: "frete + lucro alvo" },
];

/** Percentuais escalares (independem de regiao) exibidos na faixa da ficha. */
const ESCALARES: { campo: ParametroEscalarCampo; label: string; suffix: string }[] = [
  { campo: "impostos_pct", label: "Impostos", suffix: "%" },
  { campo: "despesas_pct", label: "Despesas", suffix: "%" },
  { campo: "lucro_pct", label: "Lucro alvo", suffix: "%" },
  { campo: "lucro_minimo_pct", label: "Lucro mín.", suffix: "%" },
  { campo: "taxa_horaria", label: "Custo produção", suffix: "R$/h" },
];

/** Rotulo + classe do badge de origem (nivel efetivo) de cada parametro. */
function origemTag(origem: ParametroNivel): { label: string; cls: string } {
  switch (origem) {
    case "produto":
      return { label: "PRODUTO", cls: "effecti" };
    case "linha":
      return { label: "LINHA", cls: "nomus" };
    case "global":
    default:
      return { label: "GLOBAL", cls: "" };
  }
}

const NUM = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const IFP_FMT = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** IFP e uma fracao (ex.: 0,4700); mostra ate 4 casas, "—" quando ausente. */
function fmtIfp(v: number | null): string {
  return v == null ? "—" : IFP_FMT.format(v);
}

/** Valor escalar + sufixo ("13%" / "R$ 50/h"); "—" quando ausente. */
function fmtEscalar(v: number | null, suffix: string): string {
  if (v == null) return "—";
  return `${NUM.format(v)}${suffix === "%" ? "%" : ` ${suffix}`}`;
}

/** Estilo do chip de KPI da cabeca da ficha (custo + percentuais efetivos). */
const chipStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "8px 12px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  minWidth: 116,
};

/** Indexa o grid por `regiao-patamar` para leitura O(1) das celulas. */
function indexPrecos(linhas: PrecoCalculadoLinha[]) {
  const map = new Map<string, PrecoCalculadoLinha>();
  for (const linha of linhas) map.set(`${linha.regiao}-${linha.patamar}`, linha);
  return map;
}

/**
 * cmp-preco-regional-grid — FICHA DE PREÇO do SKU (replica a planilha de
 * Engenharia de Custos da DLH num so card, RF-23): custo variavel tecnico
 * (motor), os percentuais EFETIVOS herdados (PRODUTO -> LINHA -> GLOBAL) e a
 * tabela 5 regioes x 3 patamares (FOB / CIF Minimo / CIF Alvo) com PREÇO e
 * IFP por celula. valor e ifp sao exclusivos do motor (somente leitura);
 * 'Recalcular' so aparece quando pendente/erro.
 */
export function PrecoRegionalGrid({
  skuId,
  produtoId,
}: {
  skuId: string;
  produtoId?: string;
}) {
  const precos = usePrecosCalculados(skuId);
  const resolvidos = useParametrosResolvidos(produtoId, {
    enabled: Boolean(produtoId),
  });
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
      <div className="section-title" style={{ margin: "0 0 6px" }}>
        <h3>Ficha de preço</h3>
        {!precos.isLoading && !precos.isError && (
          <StatusPill state={descriptor.state} label={descriptor.label} />
        )}
      </div>
      <p style={{ margin: "0 0 14px", fontSize: "12.5px", color: "var(--muted)" }}>
        Custo variável técnico, percentuais efetivos e os 3 patamares (FOB / CIF
        Mínimo / CIF Alvo) por região. Preço = custo ÷ IFP — calculado pelo motor.
      </p>

      {precos.isLoading ? (
        <div style={{ display: "grid", gap: 8 }}>
          {Array.from({ length: 6 }).map((_, i) => (
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
            O motor ainda não gerou a ficha deste SKU. Use “Recalcular” após
            definir composição, custos e parâmetros.
          </p>
        </div>
      ) : (
        <>
          {/* Custo + percentuais escalares efetivos (a "cabeca" da planilha). */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "stretch",
              marginBottom: 16,
            }}
          >
            <div style={{ ...chipStyle, background: "var(--accent-soft)" }}>
              <span className="sub">Custo variável técnico</span>
              <strong className="tnum" style={{ fontSize: "14px" }}>
                {formatCurrency(data.custo_base)}
              </strong>
            </div>
            {ESCALARES.map(({ campo, label, suffix }) => {
              const efetivo = resolvidos.data?.escalares[campo] ?? null;
              return (
                <div style={chipStyle} key={campo}>
                  <span
                    className="sub"
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    {label}
                    {efetivo && (
                      <span className={cn("tag", origemTag(efetivo.origem).cls)}>
                        {origemTag(efetivo.origem).label}
                      </span>
                    )}
                  </span>
                  <strong className="tnum" style={{ fontSize: "14px" }}>
                    {fmtEscalar(efetivo?.valor ?? null, suffix)}
                  </strong>
                </div>
              );
            })}
          </div>

          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Região</th>
                  <th style={{ textAlign: "right" }}>
                    Frete
                    <span
                      className="sub"
                      style={{ fontWeight: 400, display: "block" }}
                    >
                      (regional)
                    </span>
                  </th>
                  {PATAMARES.map((p) => (
                    <th key={p.value} style={{ textAlign: "right" }}>
                      {p.label}
                      <span
                        className="sub"
                        style={{ fontWeight: 400, display: "block" }}
                      >
                        ({p.hint})
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {REGIOES.map((regiao) => {
                  const frete = resolvidos.data?.regional[regiao.value] ?? null;
                  return (
                    <tr key={regiao.value}>
                      <td>{regiao.label}</td>
                      <td style={{ textAlign: "right" }}>
                        {frete && frete.percentual != null ? (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                              justifyContent: "flex-end",
                            }}
                          >
                            <span className="tnum">{NUM.format(frete.percentual)}%</span>
                            <span className={cn("tag", origemTag(frete.origem).cls)}>
                              {origemTag(frete.origem).label}
                            </span>
                          </span>
                        ) : (
                          <span style={{ color: "var(--faint)" }}>—</span>
                        )}
                      </td>
                      {PATAMARES.map((patamar) => {
                        const cell = cells?.get(`${regiao.value}-${patamar.value}`);
                        const cellDescriptor = cell
                          ? precoEstadoDescriptor(cell.estado)
                          : null;
                        return (
                          <td key={patamar.value} style={{ textAlign: "right" }}>
                            {cell && cell.estado === "vigente" ? (
                              <span
                                style={{
                                  display: "inline-flex",
                                  flexDirection: "column",
                                  alignItems: "flex-end",
                                  gap: 1,
                                }}
                              >
                                <span className="tnum">{formatCurrency(cell.valor)}</span>
                                <span
                                  className="sub tnum"
                                  style={{ fontSize: "11px", color: "var(--faint)" }}
                                >
                                  IFP {fmtIfp(cell.ifp)}
                                </span>
                              </span>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!precos.isLoading && !precos.isError && data && (
        <div
          className="form-foot"
          style={{ marginTop: 14, justifyContent: "space-between" }}
        >
          <span style={{ color: "var(--faint)", fontSize: "12.5px" }}>
            {lastCalculo ? `Calculado em ${formatDateTimeFull(lastCalculo)}` : ""}
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
