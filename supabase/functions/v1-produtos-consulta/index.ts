// =====================================================================
// Edge Function: v1-produtos-consulta  (Dominio F - Consumo pela Lia /v1)
//   -> GET /v1-produtos-consulta?sku_id=   (ou ?produto_id=)
//
// Retorna os 3 blocos do produto/SKU para a IA Lia (US-13, RF-22, RF-23):
//   - PRECO            CIF/FOB por regiao (do motor) + estado_calculo explicito
//   - CARACTERISTICAS  atributos do produto + dados comerciais
//   - INFORMACOES PARA COTACAO  diretrizes + regras + politica de participacao
//
// Decisao Security 2 (RNF-03): o /v1 minimiza dado sensivel e JAMAIS expoe
// BOM, taxa horaria, percentuais de custo nem lucro. `tipo_origem` informa
// fabricado/comprado SEM expor a fonte de custo.
//
// Bloco PRECO (US-13, RF-22): NUNCA e bloqueado/ocultado pelo estado de
// calculo (transparencia para a Lia). Sempre retorna o ultimo valor por
// regiao/patamar JUNTO com estado_calculo (vigente/pendente/erro). Em 'erro'
// nao ha valor gravado -> CIF/FOB vem null. O HTTP permanece 200 em
// pendente/erro (o estado vai no corpo, nao no status).
//
// Autenticacao /v1 (RNF-01/RNF-02): authenticateV1 aceita a API key de
// servico read-only da Lia (Bearer, Vault) OU a sessao do cockpit. Sem
// credencial valida -> 401; sessao humana fora da allowlist -> 403. A
// consulta roda via service_role apos a borda autorizar. logSensitiveAction
// registra principal + escopo (sem vazar valores/API key).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, principalLabel } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { type SupabaseClient } from "@supabase/supabase-js";
import { isUuid } from "../_shared/rest.ts";

const FUNCTION_SEGMENT = "v1-produtos-consulta";

/** Escopo logico auditado (consumo do dominio Produtos via /v1). */
const ESCOPO = "produtos-consulta";

/** Regioes fixas do grid de precos (ordem estavel para a Lia). */
const REGIOES = ["S", "SE", "CO", "NE", "N"] as const;
type Regiao = (typeof REGIOES)[number];

/** Patamares fixos do grid (CIF/FOB). */
const PATAMARES = ["CIF", "FOB"] as const;

type ServiceClient = SupabaseClient;

// ---------------------------------------------------------------------
// Tipos de linha (apenas colunas NAO sensiveis sao selecionadas)
// ---------------------------------------------------------------------

interface SkuRow {
  id: string;
  produto_id: string;
  codigo_sku: string;
  tipo_origem: string;
  dimensoes: unknown;
  tolerancia_pct: number | null;
  acabamento: string | null;
  peso_gr: number | null;
  estado_calculo: string;
}

interface ProdutoRow {
  id: string;
  linha_id: string;
  nome: string;
  atributos: Record<string, unknown> | null;
  prazo_entrega: string | null;
  disponibilidade: string | null;
  pedido_minimo: string | null;
}

interface PrecoRow {
  regiao: string;
  patamar: string;
  valor: number | null;
}

interface DiretrizRow {
  nivel: string;
  texto: string;
}

interface RegraRow {
  nivel: string;
  atributo: string;
  tipo_regra: string;
  valor_min: number | null;
  valor_max: number | null;
  substituicao: string | null;
}

interface PoliticaRow {
  nivel: string;
  participa: string;
  condicao: string | null;
  diretriz_texto: string | null;
  preferencia: string | null;
}

// Colunas explicitas: NUNCA selecionamos custo/percentual/lucro/BOM.
const SKU_COLUMNS =
  "id, produto_id, codigo_sku, tipo_origem, dimensoes, tolerancia_pct, acabamento, peso_gr, estado_calculo";
const PRODUTO_COLUMNS =
  "id, linha_id, nome, atributos, prazo_entrega, disponibilidade, pedido_minimo";

// ---------------------------------------------------------------------
// Resolucao do SKU/Produto alvo
// ---------------------------------------------------------------------

/** Carrega o SKU pelo id; 404 quando inexistente. */
async function loadSkuById(db: ServiceClient, skuId: string): Promise<SkuRow> {
  const { data, error } = await db
    .from("produto_skus")
    .select(SKU_COLUMNS)
    .eq("id", skuId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "sku_query_failed", "falha ao consultar o SKU");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "SKU nao encontrado");
  }
  return data as SkuRow;
}

/**
 * Resolve o SKU representativo de um produto: o primeiro SKU ativo (ordenado
 * por codigo_sku) e, na ausencia de ativos, o primeiro existente. Retorna null
 * quando o produto nao possui SKU (o bloco PRECO sai com estado null).
 */
async function loadSkuByProduto(db: ServiceClient, produtoId: string): Promise<SkuRow | null> {
  const { data, error } = await db
    .from("produto_skus")
    .select(SKU_COLUMNS)
    .eq("produto_id", produtoId)
    .order("ativo", { ascending: false })
    .order("codigo_sku", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "sku_query_failed", "falha ao consultar o SKU do produto");
  }
  return (data as SkuRow | null) ?? null;
}

/** Carrega o produto pelo id; 404 quando inexistente. */
async function loadProduto(db: ServiceClient, produtoId: string): Promise<ProdutoRow> {
  const { data, error } = await db
    .from("produtos")
    .select(PRODUTO_COLUMNS)
    .eq("id", produtoId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "produto_query_failed", "falha ao consultar o produto");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "produto nao encontrado");
  }
  return data as ProdutoRow;
}

/** Nome da Linha do produto (string | null). */
async function loadLinhaNome(db: ServiceClient, linhaId: string): Promise<string | null> {
  const { data, error } = await db
    .from("produto_linhas")
    .select("nome")
    .eq("id", linhaId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "linha_query_failed", "falha ao consultar a Linha");
  }
  return (data?.nome as string | undefined) ?? null;
}

// ---------------------------------------------------------------------
// Bloco PRECO (CIF/FOB por regiao + estado_calculo)
// ---------------------------------------------------------------------

type PatamarValores = { CIF: number | null; FOB: number | null };
type RegioesMap = Record<Regiao, PatamarValores>;

/** Grid de regioes inicializado com CIF/FOB null (sempre presente). */
function emptyRegioes(): RegioesMap {
  const map = {} as RegioesMap;
  for (const regiao of REGIOES) {
    map[regiao] = { CIF: null, FOB: null };
  }
  return map;
}

/**
 * Monta o bloco PRECO. NUNCA bloqueia/oculta por estado: preenche o ultimo
 * valor disponivel por regiao/patamar e expoe estado_calculo. Em 'erro' (sem
 * valor gravado) CIF/FOB ficam null. Quando nao ha SKU, estado vem null.
 */
async function buildPreco(
  db: ServiceClient,
  sku: SkuRow | null,
): Promise<{ regioes: RegioesMap; estado_calculo: string | null }> {
  const regioes = emptyRegioes();
  if (!sku) {
    return { regioes, estado_calculo: null };
  }

  const { data, error } = await db
    .from("sku_precos_calculados")
    .select("regiao, patamar, valor")
    .eq("sku_id", sku.id);
  if (error) {
    throw new HttpError(500, "precos_query_failed", "falha ao consultar os precos");
  }

  for (const row of (data as PrecoRow[] | null) ?? []) {
    const regiao = row.regiao as Regiao;
    const patamar = row.patamar as (typeof PATAMARES)[number];
    if (regiao in regioes && (patamar === "CIF" || patamar === "FOB")) {
      regioes[regiao][patamar] = row.valor;
    }
  }

  // estado_calculo vem do proprio SKU (fonte de verdade do motor). Em 'erro'
  // os valores acima permanecem null (o motor nao grava valor em erro).
  return { regioes, estado_calculo: sku.estado_calculo };
}

// ---------------------------------------------------------------------
// Bloco INFORMACOES PARA COTACAO (diretrizes + regras + politica)
// ---------------------------------------------------------------------

/**
 * Carrega criterios aplicaveis ao SKU/Produto. Diretrizes e regras agregam os
 * niveis LINHA e PRODUTO (ambos aplicaveis); a politica e RESOLVIDA com
 * precedencia PRODUTO sobre LINHA (registro unico). escopo_id e FK logica:
 * nivel='produto' -> produto.id; nivel='linha' -> produto.linha_id.
 */
async function buildInformacoesCotacao(
  db: ServiceClient,
  produtoId: string,
  linhaId: string,
): Promise<{
  diretrizes: Array<{ nivel: string; texto: string }>;
  regras: Array<{
    nivel: string;
    atributo: string;
    tipo_regra: string;
    valor_min: number | null;
    valor_max: number | null;
    substituicao: string | null;
  }>;
  politica:
    | {
      participa: string;
      condicao: string | null;
      diretriz_texto: string | null;
      preferencia: string | null;
    }
    | null;
}> {
  const escopos = [produtoId, linhaId];

  const [diretrizesRes, regrasRes, politicaRes] = await Promise.all([
    db
      .from("cotacao_diretrizes")
      .select("nivel, texto")
      .in("escopo_id", escopos)
      .order("nivel", { ascending: true })
      .order("created_at", { ascending: true }),
    db
      .from("cotacao_regras")
      .select("nivel, atributo, tipo_regra, valor_min, valor_max, substituicao")
      .in("escopo_id", escopos)
      .order("nivel", { ascending: true })
      .order("atributo", { ascending: true }),
    db
      .from("politica_participacao")
      .select("nivel, participa, condicao, diretriz_texto, preferencia")
      .in("escopo_id", escopos),
  ]);

  if (diretrizesRes.error || regrasRes.error || politicaRes.error) {
    throw new HttpError(500, "cotacao_query_failed", "falha ao consultar informacoes de cotacao");
  }

  // O filtro .in("escopo_id", [produtoId, linhaId]) ja restringe aos escopos
  // corretos: produto.id e linha.id sao UUIDs distintos, entao um registro de
  // nivel='produto' nunca colide com o escopo da Linha e vice-versa.
  const diretrizes = ((diretrizesRes.data as DiretrizRow[] | null) ?? [])
    .map((d) => ({ nivel: d.nivel, texto: d.texto }));

  const regras = ((regrasRes.data as RegraRow[] | null) ?? [])
    .map((r) => ({
      nivel: r.nivel,
      atributo: r.atributo,
      tipo_regra: r.tipo_regra,
      valor_min: r.valor_min,
      valor_max: r.valor_max,
      substituicao: r.substituicao,
    }));

  // Politica resolvida: precedencia PRODUTO sobre LINHA (registro unico).
  const politicaRows = (politicaRes.data as PoliticaRow[] | null) ?? [];
  const politicaProduto = politicaRows.find((p) => p.nivel === "produto");
  const politicaLinha = politicaRows.find((p) => p.nivel === "linha");
  const politicaResolvida = politicaProduto ?? politicaLinha ?? null;

  return {
    diretrizes,
    regras,
    politica: politicaResolvida
      ? {
        participa: politicaResolvida.participa,
        condicao: politicaResolvida.condicao,
        diretriz_texto: politicaResolvida.diretriz_texto,
        preferencia: politicaResolvida.preferencia,
      }
      : null,
  };
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");

    // Autorizacao primeiro: nao processa parametros sem credencial valida.
    const principal = await authenticateV1(req);

    const url = new URL(req.url);
    const skuIdParam = url.searchParams.get("sku_id");
    const produtoIdParam = url.searchParams.get("produto_id");

    // Exatamente UM identificador (sku_id XOR produto_id) deve ser informado.
    if (!skuIdParam && !produtoIdParam) {
      throw new HttpError(
        400,
        "validation_error",
        "informe sku_id ou produto_id",
      );
    }
    if (skuIdParam && produtoIdParam) {
      throw new HttpError(
        400,
        "validation_error",
        "informe apenas um identificador: sku_id ou produto_id",
      );
    }
    if (skuIdParam && !isUuid(skuIdParam)) {
      throw new HttpError(400, "validation_error", "sku_id invalido (UUID esperado)");
    }
    if (produtoIdParam && !isUuid(produtoIdParam)) {
      throw new HttpError(400, "validation_error", "produto_id invalido (UUID esperado)");
    }

    const db = createServiceClient();

    // Resolve SKU alvo e produto correspondente.
    let sku: SkuRow | null;
    let produto: ProdutoRow;
    if (skuIdParam) {
      sku = await loadSkuById(db, skuIdParam);
      produto = await loadProduto(db, sku.produto_id);
    } else {
      produto = await loadProduto(db, produtoIdParam as string);
      sku = await loadSkuByProduto(db, produto.id);
    }

    const linhaNome = await loadLinhaNome(db, produto.linha_id);

    const [preco, informacoesCotacao] = await Promise.all([
      buildPreco(db, sku),
      buildInformacoesCotacao(db, produto.id, produto.linha_id),
    ]);

    // Bloco do SKU: somente campos NAO sensiveis; tipo_origem informa
    // fabricado/comprado sem expor a fonte de custo (Decisao Security 2).
    const skuBlock = sku
      ? {
        id: sku.id,
        codigo_sku: sku.codigo_sku,
        tipo_origem: sku.tipo_origem,
        dimensoes: sku.dimensoes ?? null,
        tolerancia_pct: sku.tolerancia_pct,
        acabamento: sku.acabamento,
        peso_gr: sku.peso_gr,
      }
      : null;

    const body = {
      version: "v1" as const,
      produto: {
        id: produto.id,
        nome: produto.nome,
        linha: linhaNome,
      },
      sku: skuBlock,
      preco: {
        regioes: preco.regioes,
        estado_calculo: preco.estado_calculo,
      },
      caracteristicas: {
        atributos: produto.atributos ?? {},
        prazo_entrega: produto.prazo_entrega,
        disponibilidade: produto.disponibilidade,
        pedido_minimo: produto.pedido_minimo,
      },
      informacoes_cotacao: informacoesCotacao,
    };

    // Auditoria do acesso /v1: principal + escopo, sem vazar valores/API key.
    await logSensitiveAction({
      tabela: "produto_skus",
      acao: "v1_consulta",
      registroId: sku?.id ?? produto.id,
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        escopo: ESCOPO,
        produto_id: produto.id,
        sku_id: sku?.id ?? null,
      },
    });

    return jsonResponse(body, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
