import { apiFetch, buildQuery } from "@/lib/api/client";
import type {
  ParametroNivel,
  ParametroRegional,
  ParametrosCalculo,
  ParametrosResolvidos,
  PrecoApoio,
  PrecoCalculadoGrid,
  PrecoPendente,
  Regiao,
  TabelaPrecoConsolidada,
} from "@/lib/api/types";

// ---------------------------------------------------------------------
// Dominio C — Parametros de calculo (escalares + vetor regional),
// parametros resolvidos por produto e precos calculados por SKU.
// Respostas e payloads permanecem em snake_case no frontend.
// ---------------------------------------------------------------------

/** Escopo (nivel + escopo_id) usado nas leituras/escritas de parametros. */
export interface ParametroEscopo {
  nivel: ParametroNivel;
  escopo_id?: string | null;
}

// --- Parametros escalares ------------------------------------------

export function getParametros(
  escopo: ParametroEscopo,
): Promise<{ items: ParametrosCalculo[] }> {
  return apiFetch<{ items: ParametrosCalculo[] }>(
    `produtos-parametros/parametros${buildQuery({
      nivel: escopo.nivel,
      escopo_id: escopo.escopo_id,
    })}`,
    { method: "GET" },
  );
}

/** Payload do upsert de parametros escalares (PUT /parametros). */
export interface ParametrosCalculoInput {
  nivel: ParametroNivel;
  escopo_id?: string | null;
  impostos_pct?: number | null;
  frete_pct?: number | null;
  despesas_pct?: number | null;
  lucro_pct?: number | null;
  lucro_minimo_pct?: number | null;
  taxa_horaria?: number | null;
  /** Jornada (horas/dia) — so persiste no nivel global. */
  horas_por_dia?: number | null;
}

export function upsertParametros(
  input: ParametrosCalculoInput,
): Promise<ParametrosCalculo> {
  return apiFetch<ParametrosCalculo>("produtos-parametros/parametros", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

// --- Vetor regional -------------------------------------------------

export function getParametrosRegional(
  escopo: ParametroEscopo,
): Promise<{ items: ParametroRegional[] }> {
  return apiFetch<{ items: ParametroRegional[] }>(
    `produtos-parametros/parametros-regional${buildQuery({
      nivel: escopo.nivel,
      escopo_id: escopo.escopo_id,
    })}`,
    { method: "GET" },
  );
}

/** Uma regiao do payload do upsert do vetor regional. */
export interface ParametroRegionalItemInput {
  regiao: Regiao;
  percentual: number | null;
}

/** Payload do upsert do vetor regional (PUT /parametros-regional). */
export interface ParametrosRegionalInput {
  nivel: ParametroNivel;
  escopo_id?: string | null;
  regioes: ParametroRegionalItemInput[];
}

export function upsertParametrosRegional(
  input: ParametrosRegionalInput,
): Promise<{ items: ParametroRegional[] }> {
  return apiFetch<{ items: ParametroRegional[] }>(
    "produtos-parametros/parametros-regional",
    { method: "PUT", body: JSON.stringify(input) },
  );
}

// --- Parametros resolvidos por produto -----------------------------

export function getParametrosResolvidos(
  produtoId: string,
): Promise<ParametrosResolvidos> {
  return apiFetch<ParametrosResolvidos>(
    `produtos-parametros/parametros-resolvidos${buildQuery({ produto_id: produtoId })}`,
    { method: "GET" },
  );
}

// --- Precos calculados por SKU -------------------------------------

export function getPrecosCalculados(
  skuId: string,
): Promise<PrecoCalculadoGrid> {
  return apiFetch<PrecoCalculadoGrid>(
    `produtos-precos/skus/${skuId}/precos`,
    { method: "GET" },
  );
}

/** PUT /skus/:skuId/precos/apoio — UNICOS campos gravaveis do grid (RF-23). */
export function updatePrecoApoio(
  skuId: string,
  apoio: PrecoApoio,
): Promise<PrecoCalculadoGrid> {
  // Body ACHATADO (preco_concorrencia/custo_ideal no topo): o edge valida com
  // precoApoioSchema.strict(), que rejeita um envelope { apoio: ... }.
  return apiFetch<PrecoCalculadoGrid>(
    `produtos-precos/skus/${skuId}/precos/apoio`,
    { method: "PUT", body: JSON.stringify(apoio) },
  );
}

/** POST /skus/:skuId/recalcular — forca o recalculo do grid do SKU. */
export function recalcularSku(skuId: string): Promise<PrecoCalculadoGrid> {
  return apiFetch<PrecoCalculadoGrid>(
    `produtos-precos/skus/${skuId}/recalcular`,
    { method: "POST" },
  );
}

export function listPrecosPendentes(): Promise<{ items: PrecoPendente[] }> {
  return apiFetch<{ items: PrecoPendente[] }>(
    "produtos-precos/precos/pendentes",
    { method: "GET" },
  );
}

/**
 * GET /precos/consolidado?linha_id= — Tabela de Preços da Linha inteira
 * (Produtos -> SKUs -> celulas regiao x patamar) num so payload.
 */
export function getTabelaPrecos(
  linhaId: string,
): Promise<TabelaPrecoConsolidada> {
  return apiFetch<TabelaPrecoConsolidada>(
    `produtos-precos/precos/consolidado${buildQuery({ linha_id: linhaId })}`,
    { method: "GET" },
  );
}
