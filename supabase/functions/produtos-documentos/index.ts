// =====================================================================
// Edge Function: produtos-documentos  (Dominio H - Documentos PDF MVP)
// Geracao dos 3 documentos do MVP como PDF EFEMERO (streaming binario,
// Content-Type application/pdf + Content-Disposition attachment). O PDF
// NUNCA e persistido no Storage: cada chamada regenera a partir dos dados
// vivos (atributos, fotos, motor de calculo). Sem signed URL, sem retencao.
//
// Rotas:
//   POST /documentos/ficha-tecnica          { produto_id }        US-17/RF-28
//   POST /documentos/composicao-custos       { sku_id }            US-18/RF-29
//   POST /documentos/lista-precos-licitacao  { sku_ids: [uuid] }   US-19/RF-30
//
// Regras:
//   - ficha-tecnica: atributos + fotos do Produto; campos ausentes omitidos.
//   - composicao-custos: SO para SKU 'fabricado' (comprado -> 422). Valores
//     vem EXCLUSIVAMENTE do motor (sku_precos_calculados / fn_recalcular_sku),
//     nunca digitados. Estrutura interna {itens, custos, percentuais,
//     preco_final} alimenta o template (Lacuna: template oficial do pregoeiro).
//   - lista-precos-licitacao: grid CIF/FOB por regiao dos SKUs, sinalizando
//     pendentes/erro de recalculo.
//
// Borda: handleCorsPreflight -> assertMethod -> requireAuthorizedUser ->
// validacao zod -> roteamento. Leitura server-side via service_role.
// =====================================================================

import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { type SupabaseClient } from "@supabase/supabase-js";
import { logSensitiveAction } from "../_shared/audit.ts";
import { routeSegments } from "../_shared/rest.ts";
import {
  composicaoCustosSchema,
  fichaTecnicaSchema,
  listaPrecosLicitacaoSchema,
  parseJsonBody,
} from "../_shared/validation.ts";
import { PdfBuilder, type TableColumn } from "../_shared/pdf.ts";

const FUNCTION_SEGMENT = "produtos-documentos";
const BUCKET = "produtos";

/** Regioes fixas do grid (ordem estavel). */
const REGIOES = ["S", "SE", "CO", "NE", "N"] as const;
type Regiao = (typeof REGIOES)[number];

type ServiceClient = SupabaseClient;

// ---------------------------------------------------------------------
// Helpers de formatacao / coercao
// ---------------------------------------------------------------------

/** Coage valores numericos (number ou string do PostgREST) para number|null. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const NUM4 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const PCT = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** Formata moeda BRL; null/ausente -> traco. */
function money(value: number | null): string {
  return value === null ? "-" : BRL.format(value);
}

/** Formata quantidade (ate 4 casas); null -> traco. */
function quantity(value: number | null): string {
  return value === null ? "-" : NUM4.format(value);
}

/** Formata percentual (pontos percentuais); null -> traco. */
function percent(value: number | null): string {
  return value === null ? "-" : `${PCT.format(value)}%`;
}

/** Slug ASCII seguro para o nome do arquivo no Content-Disposition. */
function asciiSlug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60) || "documento";
}

/** Rotulo legivel do estado de calculo (com marcador de pendencia). */
function estadoLabel(estado: string | null): string {
  if (estado === "vigente") return "vigente";
  if (estado === "pendente") return "pendente de recalculo";
  if (estado === "erro") return "erro de calculo";
  return estado ?? "indisponivel";
}

/** Resposta PDF efemera: binario + attachment + CORS (nunca persiste). */
function pdfResponse(bytes: Uint8Array, filename: string): Response {
  // Copia para um ArrayBuffer concreto (evita a friccao de tipagem entre
  // Uint8Array<ArrayBufferLike> e BodyInit nas libs do Deno/TS).
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Response(buffer, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "Content-Length": String(bytes.byteLength),
    },
  });
}

// ---------------------------------------------------------------------
// Loaders compartilhados
// ---------------------------------------------------------------------

interface ProdutoRow {
  id: string;
  linha_id: string;
  nome: string;
  atributos: Record<string, unknown> | null;
  prazo_entrega: string | null;
  disponibilidade: string | null;
  pedido_minimo: string | null;
}

interface SkuRow {
  id: string;
  produto_id: string;
  codigo_sku: string;
  tipo_origem: string;
  tempo_producao: number | null;
  estado_calculo: string;
}

async function loadProduto(db: ServiceClient, produtoId: string): Promise<ProdutoRow> {
  const { data, error } = await db
    .from("produtos")
    .select("id, linha_id, nome, atributos, prazo_entrega, disponibilidade, pedido_minimo")
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

async function loadSku(db: ServiceClient, skuId: string): Promise<SkuRow> {
  const { data, error } = await db
    .from("produto_skus")
    .select("id, produto_id, codigo_sku, tipo_origem, tempo_producao, estado_calculo")
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

/** Grid CIF/FOB por regiao (do motor); ausentes ficam null. */
type PatamarValores = { CIF: number | null; FOB: number | null };
type RegioesMap = Record<Regiao, PatamarValores>;

function emptyRegioes(): RegioesMap {
  const map = {} as RegioesMap;
  for (const r of REGIOES) map[r] = { CIF: null, FOB: null };
  return map;
}

async function loadGrid(
  db: ServiceClient,
  skuId: string,
): Promise<{ regioes: RegioesMap; custoBase: number | null }> {
  const { data, error } = await db
    .from("sku_precos_calculados")
    .select("regiao, patamar, valor, custo_base")
    .eq("sku_id", skuId);
  if (error) {
    throw new HttpError(500, "precos_query_failed", "falha ao consultar os precos");
  }
  const regioes = emptyRegioes();
  let custoBase: number | null = null;
  for (const row of (data as Array<Record<string, unknown>> | null) ?? []) {
    const regiao = row.regiao as Regiao;
    const patamar = row.patamar as "CIF" | "FOB";
    if (regiao in regioes && (patamar === "CIF" || patamar === "FOB")) {
      regioes[regiao][patamar] = num(row.valor);
    }
    if (custoBase === null) custoBase = num(row.custo_base);
  }
  return { regioes, custoBase };
}

// =====================================================================
// POST /documentos/ficha-tecnica  { produto_id }
// =====================================================================

interface AtributoSchemaRow {
  chave: string;
  tipo: string;
  obrigatorio: boolean;
}

interface ImagemRow {
  storage_path: string;
  legenda: string | null;
  ordem: number;
}

/** True quando o valor de atributo/comercial tem conteudo exibivel. */
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/** Converte um valor de atributo (jsonb) para string legivel. */
function attrToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

async function fichaTecnica(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, fichaTecnicaSchema);
  const db = createServiceClient();

  const produto = await loadProduto(db, input.produto_id);
  const linhaNome = await loadLinhaNome(db, produto.linha_id);

  const [schemaRes, imagensRes] = await Promise.all([
    db
      .from("produto_linha_atributos")
      .select("chave, tipo, obrigatorio")
      .eq("linha_id", produto.linha_id)
      .order("chave", { ascending: true }),
    db
      .from("produto_imagens")
      .select("storage_path, legenda, ordem")
      .eq("produto_id", produto.id)
      .order("ordem", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);
  if (schemaRes.error || imagensRes.error) {
    throw new HttpError(500, "ficha_query_failed", "falha ao montar a ficha tecnica");
  }
  const schema = (schemaRes.data as AtributoSchemaRow[] | null) ?? [];
  const imagens = (imagensRes.data as ImagemRow[] | null) ?? [];
  const atributos = produto.atributos ?? {};

  const pdf = await PdfBuilder.create();
  pdf.title("Ficha Tecnica");
  pdf.subtitle(produto.nome);

  // ----- Identificacao (campos ausentes omitidos) -----
  pdf.heading("Identificacao");
  pdf.keyValue("Produto", produto.nome);
  if (linhaNome) pdf.keyValue("Linha", linhaNome);
  if (hasValue(produto.prazo_entrega)) {
    pdf.keyValue("Prazo de entrega", String(produto.prazo_entrega));
  }
  if (hasValue(produto.disponibilidade)) {
    pdf.keyValue("Disponibilidade", String(produto.disponibilidade));
  }
  if (hasValue(produto.pedido_minimo)) {
    pdf.keyValue("Pedido minimo", String(produto.pedido_minimo));
  }
  pdf.spacer(6);

  // ----- Atributos (ordem do schema; depois extras; ausentes omitidos) -----
  const renderedKeys = new Set<string>();
  const atributoLinhas: Array<{ chave: string; valor: string }> = [];
  for (const attr of schema) {
    const valor = (atributos as Record<string, unknown>)[attr.chave];
    if (hasValue(valor)) {
      atributoLinhas.push({ chave: attr.chave, valor: attrToString(valor) });
      renderedKeys.add(attr.chave);
    }
  }
  for (const [chave, valor] of Object.entries(atributos)) {
    if (renderedKeys.has(chave) || !hasValue(valor)) continue;
    atributoLinhas.push({ chave, valor: attrToString(valor) });
  }
  if (atributoLinhas.length > 0) {
    pdf.heading("Atributos");
    for (const linha of atributoLinhas) {
      pdf.keyValue(linha.chave, linha.valor);
    }
    pdf.spacer(6);
  }

  // ----- Fotos (JPG/PNG incorporadas; formatos nao suportados omitidos) -----
  if (imagens.length > 0) {
    let headingDrawn = false;
    for (const imagem of imagens) {
      const download = await db.storage.from(BUCKET).download(imagem.storage_path);
      if (download.error || !download.data) continue; // objeto ausente: omite
      const mime = download.data.type || mimeFromPath(imagem.storage_path);
      const bytes = new Uint8Array(await download.data.arrayBuffer());
      if (!headingDrawn) {
        pdf.heading("Fotos");
        headingDrawn = true;
      }
      await pdf.image(bytes, mime, { caption: imagem.legenda, maxHeight: 240 });
    }
  }

  const bytes = await pdf.finish();

  await logSensitiveAction({
    tabela: "produtos",
    acao: "documento_ficha_tecnica",
    registroId: produto.id,
    usuario: email,
    dadosNovos: { produto_id: produto.id },
  });

  return pdfResponse(bytes, `ficha-tecnica-${asciiSlug(produto.nome)}.pdf`);
}

/** Deriva o MIME a partir da extensao do objeto (fallback do blob.type). */
function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

// =====================================================================
// POST /documentos/composicao-custos  { sku_id }
// SO para SKU 'fabricado' (comprado -> 422). Valores do motor.
// =====================================================================

interface ComposicaoItem {
  descricao: string;
  quantidade: number | null;
  unidade: string | null;
  preco_unitario: number | null;
  subtotal: number | null;
}

interface ComposicaoData {
  itens: ComposicaoItem[];
  custos: {
    custo_insumos: number | null;
    mao_de_obra: number | null;
    custo_variavel: number | null;
  };
  percentuais: {
    impostos_pct: number | null;
    frete_pct: number | null;
    despesas_pct: number | null;
    lucro_pct: number | null;
    taxa_horaria: number | null;
    regional: Record<Regiao, number | null>;
  };
  preco_final: { regioes: RegioesMap };
  estado_calculo: string;
}

/** Resolve um escalar de parametros_calculo por PRODUTO -> LINHA -> GLOBAL. */
async function resolveScalar(
  db: ServiceClient,
  field: string,
  produtoId: string,
  linhaId: string,
): Promise<number | null> {
  const { data, error } = await db
    .from("parametros_calculo")
    .select(`nivel, escopo_id, ${field}`)
    .or(
      `and(nivel.eq.produto,escopo_id.eq.${produtoId}),` +
        `and(nivel.eq.linha,escopo_id.eq.${linhaId}),` +
        `and(nivel.eq.global,escopo_id.is.null)`,
    );
  if (error) {
    throw new HttpError(500, "parametros_query_failed", "falha ao resolver parametros");
  }
  // O select dinamico (`${field}`) desabilita a inferencia tipada do PostgREST;
  // normalizamos via unknown para o shape generico de linha.
  const rows = (data as unknown as Array<Record<string, unknown>> | null) ?? [];
  const byNivel = (nivel: string) => rows.find((r) => r.nivel === nivel);
  for (const nivel of ["produto", "linha", "global"]) {
    const row = byNivel(nivel);
    const valor = row ? num(row[field]) : null;
    if (valor !== null) return valor;
  }
  return null;
}

/** Resolve o vetor regional (percentual por regiao) PRODUTO -> LINHA -> GLOBAL. */
async function resolveRegional(
  db: ServiceClient,
  produtoId: string,
  linhaId: string,
): Promise<Record<Regiao, number | null>> {
  const { data, error } = await db
    .from("parametro_regional")
    .select("nivel, escopo_id, regiao, percentual")
    .or(
      `and(nivel.eq.produto,escopo_id.eq.${produtoId}),` +
        `and(nivel.eq.linha,escopo_id.eq.${linhaId}),` +
        `and(nivel.eq.global,escopo_id.is.null)`,
    );
  if (error) {
    throw new HttpError(500, "regional_query_failed", "falha ao resolver vetor regional");
  }
  const rows = (data as Array<Record<string, unknown>> | null) ?? [];
  const out = {} as Record<Regiao, number | null>;
  for (const regiao of REGIOES) {
    let resolved: number | null = null;
    for (const nivel of ["produto", "linha", "global"]) {
      const row = rows.find((r) => r.nivel === nivel && r.regiao === regiao);
      const valor = row ? num(row.percentual) : null;
      if (valor !== null) {
        resolved = valor;
        break;
      }
    }
    out[regiao] = resolved;
  }
  return out;
}

/** Custo unitario vigente de um insumo (mesma regra do motor). */
function vigentePreco(
  precos: Array<
    {
      insumo_id: string;
      preco: unknown;
      vigencia_inicio: string;
      vigencia_fim: string | null;
      created_at: string;
    }
  >,
  insumoId: string,
): number | null {
  const hoje = new Date().toISOString().slice(0, 10);
  const candidatos = precos
    .filter((p) => p.insumo_id === insumoId && (p.vigencia_fim === null || p.vigencia_fim >= hoje))
    .sort((a, b) => {
      if (a.vigencia_inicio !== b.vigencia_inicio) {
        return a.vigencia_inicio < b.vigencia_inicio ? 1 : -1;
      }
      return a.created_at < b.created_at ? 1 : -1;
    });
  return candidatos.length > 0 ? num(candidatos[0].preco) : null;
}

/**
 * Monta a estrutura interna {itens, custos, percentuais, preco_final} da
 * composicao de custos. custo_variavel e preco_final vem do motor
 * (sku_precos_calculados); os itens/percentuais sao derivados das MESMAS
 * fontes de verdade que o motor consome (BOM + precos vigentes + parametros),
 * nunca de valores digitados no momento da geracao.
 */
async function buildComposicaoData(
  db: ServiceClient,
  sku: SkuRow,
  produto: ProdutoRow,
): Promise<ComposicaoData> {
  const linhaId = produto.linha_id;

  // BOM do SKU.
  const { data: bomData, error: bomError } = await db
    .from("sku_composicao")
    .select("insumo_id, quantidade, unidade, created_at")
    .eq("sku_id", sku.id)
    .order("created_at", { ascending: true });
  if (bomError) {
    throw new HttpError(500, "composicao_query_failed", "falha ao consultar a composicao");
  }
  const bom = (bomData as Array<Record<string, unknown>> | null) ?? [];
  const insumoIds = Array.from(new Set(bom.map((b) => b.insumo_id as string)));

  // Nomes/unidades dos insumos e precos vigentes (uma consulta cada).
  const [insumosRes, precosRes, gridRes, impostos, frete, despesas, lucro, taxa, regional] =
    await Promise.all([
      insumoIds.length > 0
        ? db.from("insumos").select("id, nome, unidade").in("id", insumoIds)
        : Promise.resolve({ data: [], error: null }),
      insumoIds.length > 0
        ? db
          .from("insumo_precos")
          .select("insumo_id, preco, vigencia_inicio, vigencia_fim, created_at")
          .in("insumo_id", insumoIds)
        : Promise.resolve({ data: [], error: null }),
      loadGrid(db, sku.id),
      resolveScalar(db, "impostos_pct", produto.id, linhaId),
      resolveScalar(db, "frete_pct", produto.id, linhaId),
      resolveScalar(db, "despesas_pct", produto.id, linhaId),
      resolveScalar(db, "lucro_pct", produto.id, linhaId),
      resolveScalar(db, "taxa_horaria", produto.id, linhaId),
      resolveRegional(db, produto.id, linhaId),
    ]);

  if (insumosRes.error || precosRes.error) {
    throw new HttpError(500, "insumos_query_failed", "falha ao consultar os insumos da composicao");
  }

  const insumosById = new Map<string, { nome: string; unidade: string | null }>();
  for (const row of (insumosRes.data as Array<Record<string, unknown>> | null) ?? []) {
    insumosById.set(row.id as string, {
      nome: row.nome as string,
      unidade: (row.unidade as string | null) ?? null,
    });
  }
  const precos = ((precosRes.data as Array<Record<string, unknown>> | null) ?? []).map((p) => ({
    insumo_id: p.insumo_id as string,
    preco: p.preco,
    vigencia_inicio: p.vigencia_inicio as string,
    vigencia_fim: (p.vigencia_fim as string | null) ?? null,
    created_at: p.created_at as string,
  }));

  // Itens de insumo (quantidade * preco vigente).
  const itens: ComposicaoItem[] = [];
  let custoInsumos = 0;
  let custoInsumosCompleto = true;
  for (const b of bom) {
    const insumoId = b.insumo_id as string;
    const insumo = insumosById.get(insumoId);
    const quantidade = num(b.quantidade);
    const precoUnit = vigentePreco(precos, insumoId);
    const subtotal = quantidade !== null && precoUnit !== null ? quantidade * precoUnit : null;
    if (subtotal === null) custoInsumosCompleto = false;
    else custoInsumos += subtotal;
    itens.push({
      descricao: insumo?.nome ?? "Insumo",
      quantidade,
      unidade: (b.unidade as string | null) ?? insumo?.unidade ?? null,
      preco_unitario: precoUnit,
      subtotal,
    });
  }

  // Mao de obra: tempo_producao * taxa_horaria resolvida.
  const tempo = num(sku.tempo_producao);
  const maoDeObra = (tempo ?? 0) * (taxa ?? 0);
  if (tempo !== null && taxa !== null && maoDeObra > 0) {
    itens.push({
      descricao: "Mao de obra",
      quantidade: tempo,
      unidade: "h",
      preco_unitario: taxa,
      subtotal: maoDeObra,
    });
  }

  // custo_variavel: PRIORIDADE ao valor do motor (custo_base). Fallback para a
  // soma derivada quando o grid ainda nao foi materializado.
  const custoInsumosValor = custoInsumosCompleto ? custoInsumos : null;
  const custoVariavelDerivado = custoInsumosCompleto ? custoInsumos + maoDeObra : null;
  const custoVariavel = gridRes.custoBase ?? custoVariavelDerivado;

  return {
    itens,
    custos: {
      custo_insumos: custoInsumosValor,
      mao_de_obra: itens.some((i) => i.descricao === "Mao de obra") ? maoDeObra : null,
      custo_variavel: custoVariavel,
    },
    percentuais: {
      impostos_pct: impostos,
      frete_pct: frete,
      despesas_pct: despesas,
      lucro_pct: lucro,
      taxa_horaria: taxa,
      regional,
    },
    preco_final: { regioes: gridRes.regioes },
    estado_calculo: sku.estado_calculo,
  };
}

async function composicaoCustos(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, composicaoCustosSchema);
  const db = createServiceClient();

  const sku = await loadSku(db, input.sku_id);
  // SO SKU fabricado tem BOM; comprado -> 422 (composicao nao aplicavel).
  if (sku.tipo_origem !== "fabricado") {
    throw new HttpError(
      422,
      "sku_comprado_sem_bom",
      "composicao de custos nao aplicavel: SKU comprado nao possui BOM",
    );
  }

  const produto = await loadProduto(db, sku.produto_id);
  const linhaNome = await loadLinhaNome(db, produto.linha_id);
  const data = await buildComposicaoData(db, sku, produto);

  // ----- Renderizacao do PDF a partir da estrutura interna -----
  const pdf = await PdfBuilder.create();
  pdf.title("Composicao de Custos");
  pdf.subtitle(`${produto.nome}  -  SKU ${sku.codigo_sku}`);

  pdf.heading("Identificacao");
  pdf.keyValue("Produto", produto.nome);
  if (linhaNome) pdf.keyValue("Linha", linhaNome);
  pdf.keyValue("SKU", sku.codigo_sku);
  pdf.keyValue("Estado do calculo", estadoLabel(data.estado_calculo));
  pdf.spacer(6);

  // Itens (BOM + mao de obra).
  pdf.heading("Itens da composicao");
  const itemColumns: TableColumn[] = [
    { header: "Descricao", width: 42 },
    { header: "Qtd.", width: 14, align: "right" },
    { header: "Un.", width: 10 },
    { header: "Custo unit.", width: 17, align: "right" },
    { header: "Subtotal", width: 17, align: "right" },
  ];
  const itemRows = data.itens.map((item) => [
    item.descricao,
    quantity(item.quantidade),
    item.unidade ?? "-",
    money(item.preco_unitario),
    money(item.subtotal),
  ]);
  if (itemRows.length === 0) {
    itemRows.push(["(sem itens de composicao)", "-", "-", "-", "-"]);
  }
  pdf.table(itemColumns, itemRows);

  // Custos consolidados (do motor).
  pdf.heading("Custos");
  pdf.keyValue("Custo de insumos", money(data.custos.custo_insumos));
  pdf.keyValue("Mao de obra", money(data.custos.mao_de_obra));
  pdf.keyValue("Custo variavel (motor)", money(data.custos.custo_variavel));
  pdf.spacer(6);

  // Percentuais resolvidos.
  pdf.heading("Percentuais aplicados");
  pdf.keyValue("Impostos", percent(data.percentuais.impostos_pct));
  pdf.keyValue("Frete (CIF)", percent(data.percentuais.frete_pct));
  pdf.keyValue("Despesas", percent(data.percentuais.despesas_pct));
  pdf.keyValue("Lucro", percent(data.percentuais.lucro_pct));
  pdf.keyValue("Taxa horaria", money(data.percentuais.taxa_horaria));
  pdf.spacer(6);

  // Preco final por regiao (CIF/FOB) - exclusivamente do motor.
  pdf.heading("Preco final por regiao");
  const precoColumns: TableColumn[] = [
    { header: "Regiao", width: 30 },
    { header: "Ajuste regional", width: 24, align: "right" },
    { header: "CIF", width: 23, align: "right" },
    { header: "FOB", width: 23, align: "right" },
  ];
  const precoRows = REGIOES.map((regiao) => [
    regiao,
    percent(data.percentuais.regional[regiao]),
    money(data.preco_final.regioes[regiao].CIF),
    money(data.preco_final.regioes[regiao].FOB),
  ]);
  pdf.table(precoColumns, precoRows);

  if (data.estado_calculo !== "vigente") {
    pdf.spacer(4);
    pdf.paragraph(
      `Atencao: o calculo deste SKU esta em estado "${estadoLabel(data.estado_calculo)}". ` +
        "Os valores podem estar desatualizados ou indisponiveis ate o recalculo.",
    );
  }

  const bytes = await pdf.finish();

  await logSensitiveAction({
    tabela: "produto_skus",
    acao: "documento_composicao_custos",
    registroId: sku.id,
    usuario: email,
    dadosNovos: { sku_id: sku.id, estado_calculo: data.estado_calculo },
  });

  return pdfResponse(bytes, `composicao-custos-${asciiSlug(sku.codigo_sku)}.pdf`);
}

// =====================================================================
// POST /documentos/lista-precos-licitacao  { sku_ids: [uuid] }
// Grid CIF/FOB por regiao dos SKUs; sinaliza pendentes/erro de recalculo.
// =====================================================================

async function listaPrecosLicitacao(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, listaPrecosLicitacaoSchema);
  const db = createServiceClient();

  // Carrega cada SKU na ordem informada; SKU inexistente -> 404.
  interface SkuEntry {
    sku: SkuRow;
    produtoNome: string;
    regioes: RegioesMap;
  }
  const entries: SkuEntry[] = [];
  for (const skuId of input.sku_ids) {
    const sku = await loadSku(db, skuId);
    const produto = await loadProduto(db, sku.produto_id);
    const { regioes } = await loadGrid(db, sku.id);
    entries.push({ sku, produtoNome: produto.nome, regioes });
  }

  const pdf = await PdfBuilder.create();
  pdf.title("Lista de Precos de Licitacao");
  pdf.subtitle(
    `${entries.length} SKU(s)  -  gerado em ${new Date().toISOString().slice(0, 10)}`,
  );

  const temPendencia = entries.some((e) => e.sku.estado_calculo !== "vigente");
  if (temPendencia) {
    pdf.paragraph(
      "Os SKUs marcados com (!) estao pendentes de recalculo ou em erro; " +
        "os valores exibidos podem estar desatualizados ou indisponiveis.",
    );
    pdf.spacer(4);
  }

  const columns: TableColumn[] = [
    { header: "Regiao", width: 40 },
    { header: "CIF", width: 30, align: "right" },
    { header: "FOB", width: 30, align: "right" },
  ];

  for (const entry of entries) {
    const marcador = entry.sku.estado_calculo !== "vigente" ? " (!)" : "";
    pdf.heading(`${entry.produtoNome} - ${entry.sku.codigo_sku}${marcador}`);
    pdf.subtitle(`Estado: ${estadoLabel(entry.sku.estado_calculo)}`);
    const rows = REGIOES.map((regiao) => [
      regiao,
      money(entry.regioes[regiao].CIF),
      money(entry.regioes[regiao].FOB),
    ]);
    pdf.table(columns, rows);
    pdf.spacer(6);
  }

  const bytes = await pdf.finish();

  await logSensitiveAction({
    tabela: "produto_skus",
    acao: "documento_lista_precos_licitacao",
    registroId: entries[0]?.sku.id ?? null,
    usuario: email,
    dadosNovos: { sku_ids: input.sku_ids, total: entries.length },
  });

  return pdfResponse(bytes, "lista-precos-licitacao.pdf");
}

// ---------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao na borda (401 sem sessao, 403 fora da allowlist).
    const { email } = await requireAuthorizedUser(req);

    const segments = routeSegments(req, FUNCTION_SEGMENT);
    const root = segments[0];

    if (segments.length === 1 && root === "documentos") {
      throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
    }

    if (root === "documentos" && segments.length === 2) {
      const tipo = segments[1];
      if (tipo === "ficha-tecnica") return await fichaTecnica(req, email);
      if (tipo === "composicao-custos") return await composicaoCustos(req, email);
      if (tipo === "lista-precos-licitacao") return await listaPrecosLicitacao(req, email);
    }

    throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
