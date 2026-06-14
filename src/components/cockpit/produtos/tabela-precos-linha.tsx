"use client";

import { useState } from "react";
import { Package, Table, TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/cockpit/status-pill";
import { useTabelaPrecos } from "@/hooks/use-tabela-precos";
import { precoEstadoDescriptor } from "@/lib/status";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  Patamar,
  Regiao,
  TabelaPrecoCelula,
  TabelaPrecoSku,
} from "@/lib/api/types";

const REGIOES: { value: Regiao; label: string }[] = [
  { value: "S", label: "Sul" },
  { value: "SE", label: "Sudeste" },
  { value: "CO", label: "Centro-Oeste" },
  { value: "NE", label: "Nordeste" },
  { value: "N", label: "Norte" },
];

/** Os 3 patamares do metodo IFP (CIF Alvo e o default da tabela). */
const PATAMARES: { value: Patamar; label: string }[] = [
  { value: "FOB", label: "FOB" },
  { value: "CIF_MINIMO", label: "CIF Mínimo" },
  { value: "CIF_ALVO", label: "CIF Alvo" },
];

const IFP_FMT = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Indexa as celulas do SKU por `regiao-patamar` para leitura O(1). */
function indexSku(precos: TabelaPrecoCelula[]) {
  const map = new Map<string, TabelaPrecoCelula>();
  for (const c of precos) map.set(`${c.regiao}-${c.patamar}`, c);
  return map;
}

/** Celula de preco (valor + IFP) ou estado/traço quando nao vigente. */
function PrecoCelula({ cell }: { cell: TabelaPrecoCelula | undefined }) {
  if (cell && cell.estado === "vigente") {
    return (
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
          style={{ fontSize: "11px" }}
        >
          IFP {cell.ifp == null ? "—" : IFP_FMT.format(cell.ifp)}
        </span>
      </span>
    );
  }
  if (cell) {
    const desc = precoEstadoDescriptor(cell.estado);
    return <StatusPill state={desc.state} label={desc.label} />;
  }
  return <span style={{ color: "var(--faint)" }}>—</span>;
}

/** Uma linha de SKU: codigo + estado + preco por regiao no patamar ativo. */
function SkuRow({ sku, patamar }: { sku: TabelaPrecoSku; patamar: Patamar }) {
  const cells = indexSku(sku.precos);
  const desc = precoEstadoDescriptor(sku.estado_calculo);
  return (
    <tr>
      <td>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <StatusPill state={desc.state} label={desc.label} iconOnly />
          <span className="mono" style={{ whiteSpace: "nowrap" }}>
            {sku.codigo_sku}
          </span>
        </span>
      </td>
      {REGIOES.map((r) => (
        <td key={r.value} style={{ textAlign: "right" }}>
          <PrecoCelula cell={cells.get(`${r.value}-${patamar}`)} />
        </td>
      ))}
    </tr>
  );
}

/**
 * cmp-tabela-precos-linha — TABELA DE PREÇOS da Linha inteira (RF-23): todos os
 * SKUs (agrupados por Produto) x 5 regiões, no patamar selecionado (CIF Alvo
 * por padrão; toggle FOB / CIF Mínimo / CIF Alvo). Preço + IFP por célula,
 * somente leitura (motor). Replica a visão de planilha consolidada da DLH.
 */
export function TabelaPrecosLinha({
  linhaId,
  produtoId,
  embedded = false,
}: {
  linhaId: string;
  produtoId?: string | null;
  embedded?: boolean;
}) {
  const tabela = useTabelaPrecos(linhaId);
  const [patamar, setPatamar] = useState<Patamar>("CIF_ALVO");

  const todos = tabela.data?.produtos ?? [];
  const produtos = produtoId
    ? todos.filter((p) => p.produto_id === produtoId)
    : todos;
  const temSkus = produtos.some((p) => p.skus.length > 0);

  return (
    <div
      className={embedded ? undefined : "card"}
      style={embedded ? { padding: "14px 16px 4px" } : undefined}
    >
      <div className="section-title" style={{ margin: "0 0 6px" }}>
        <h3>Tabela de preços</h3>
        <div
          className={cn("filter-group", "segmented")}
          role="group"
          aria-label="Patamar de preço"
        >
          {PATAMARES.map((p) => (
            <button
              key={p.value}
              type="button"
              className={cn("btn", "btn-sm", patamar === p.value && "btn-primary")}
              aria-pressed={patamar === p.value}
              onClick={() => setPatamar(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {embedded ? null : (
        <p style={{ margin: "0 0 14px", fontSize: "12.5px", color: "var(--muted)" }}>
          Todos os SKUs da linha por região, no patamar selecionado. Preço + IFP
          por célula — calculado pelo motor.
        </p>
      )}

      {tabela.isLoading ? (
        <div style={{ display: "grid", gap: 8 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <span key={i} className="skel skel-line" style={{ width: "100%" }} />
          ))}
        </div>
      ) : tabela.isError ? (
        <div className="err-msg" style={{ display: "flex" }}>
          <TriangleAlert aria-hidden="true" />
          Não foi possível carregar a tabela de preços desta linha.
        </div>
      ) : !temSkus ? (
        <div className="empty">
          <Table aria-hidden="true" />
          <h4>Sem SKUs com preço</h4>
          <p>
            Cadastre Produtos e SKUs na linha para montar a tabela de preços
            consolidada.
          </p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                {REGIOES.map((r) => (
                  <th key={r.value} style={{ textAlign: "right" }}>
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {produtos.map((produto) =>
                produto.skus.length === 0 ? null : (
                  <ProdutoGroup
                    key={produto.produto_id}
                    nome={produto.nome}
                    skus={produto.skus}
                    patamar={patamar}
                    hideHeader={embedded}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Cabecalho do Produto (linha-titulo) seguido das linhas dos seus SKUs. No
 * modo embedded (tabela aberta sob o Produto) o cabecalho e omitido — o nome
 * do Produto ja aparece na linha selecionada logo acima. */
function ProdutoGroup({
  nome,
  skus,
  patamar,
  hideHeader = false,
}: {
  nome: string;
  skus: TabelaPrecoSku[];
  patamar: Patamar;
  hideHeader?: boolean;
}) {
  return (
    <>
      {hideHeader ? null : (
      <tr>
        <td
          colSpan={1 + REGIOES.length}
          style={{
            background: "var(--accent-soft)",
            fontWeight: 600,
            fontSize: "12.5px",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Package aria-hidden="true" style={{ width: 14, height: 14 }} />
            {nome}
          </span>
        </td>
      </tr>
      )}
      {skus.map((sku) => (
        <SkuRow key={sku.sku_id} sku={sku} patamar={patamar} />
      ))}
    </>
  );
}
