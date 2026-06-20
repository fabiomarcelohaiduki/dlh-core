// =====================================================================
// Edge Function: automacao-aviso-itens  (cockpit - itens extraidos por aviso)
//   -> GET /automacao-aviso-itens?aviso_id=<uuid>
//
// Da VISIBILIDADE no cockpit do que a Lia extraiu de um edital (recall por
// item). Por aviso, resolve os documentos vinculados (via effecti_id +
// documento_vinculos, dedup global) e devolve:
//   - documentos[]: nome_arquivo + itens_status (pendente|pendente_revisao|
//                   extraido|sem_itens|erro|inobtenivel|ignorado) — estado da
//                   extracao de ITENS
//   - itens[]:      as linhas literais de documento_itens (descricao integral,
//                   unidade, qtd, preco_referencia, lista_origem, fonte_descricao)
//
// SO LEITURA: o cockpit nao extrai nem reprocessa (a extracao e 1x/doc, feita
// pela Lia quando ativa). Documento `pendente` = aguardando a Lia.
//
// Autorizacao na borda (US-21): requireAuthorizedUser -> 401 sem sessao, 403
// fora da allowlist. A leitura corre com service_role apos a borda autorizar
// (tabelas de triagem/documentos ficam fora das views lia.*, SEC-3).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { normDesc } from "../_shared/normalizar.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "automacao-aviso-itens";

/**
 * Estados de extracao de TEXTO (documento_vinculos.status_extracao) com texto
 * aproveitavel — os mesmos elegiveis a extracao de itens na fila. Documentos
 * sem texto (pendente/erro/inobtenivel) nao rendem itens e ficam de fora.
 */
const STATUS_EXTRACAO_COM_TEXTO = ["extraido", "herdado", "precisa_ocr"];

/**
 * PostgREST limita a resposta a 1000 linhas; sem paginar, itens em volume
 * seriam truncados em SILENCIO (viola RECALL TOTAL). Pagina via .range().
 */
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(
  label: string,
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0;; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`falha ao ler ${label}: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

interface DocumentoFila {
  documento_id: string;
  nome_arquivo: string | null;
  itens_status: string;
}

interface ItemLicitacao {
  /** id do documento_itens — chave para correlacionar com o match (FE). */
  id: string;
  documento_id: string;
  lista_origem: string;
  fonte_descricao: string;
  item_numero: string | null;
  lote: string | null;
  descricao: string;
  unidade: string | null;
  quantidade: number | null;
  preco_referencia: number | null;
  ordem: number | null;
  /**
   * true quando este item casa com um dos itens destacados pelo Effecti
   * (avisos.payload_bruto->itensEdital, o subconjunto que bateu as palavras-chave
   * do perfil). Hint de prioridade no cockpit, NAO decisao. Cruzamento best-effort
   * por numero de item OU por descricao normalizada (a numeracao do portal nem
   * sempre coincide com a numeracao da extracao -> a descricao recupera parte).
   */
  effecti: boolean;
}

/** Match item x produto (triagem_item_matches), por aviso. */
interface ItemMatch {
  documento_item_id: string;
  produto_id: string | null;
  sku_id: string | null;
  /** Codigo legivel do SKU casado (ex: FLM-OURO-30X50), resolvido de produto_skus. */
  codigo_sku: string | null;
  produto_nome: string | null;
  score: number | null;
}

interface VinculoRow {
  documento_id: string;
}

interface DocumentoMetaRow {
  id: string;
  nome_arquivo: string | null;
  itens_status: string | null;
}

interface ItemRow {
  id: string;
  documento_id: string;
  lista_origem: string | null;
  fonte_descricao: string | null;
  item_numero: string | null;
  lote: string | null;
  descricao: string;
  unidade: string | null;
  quantidade: number | null;
  preco_referencia: number | null;
  ordem: number | null;
}

/** itensEdital do payload Effecti = subconjunto que casou as palavras-chave. */
interface ItensEditalRow {
  item?: number | string | null;
  produtoLicitadoSemTags?: string | null;
}

interface AvisoMeta {
  effectiId: string;
  itensEffecti: ItensEditalRow[];
}

/**
 * Resolve effecti_id (chave do vinculo de documentos) + o itensEdital do
 * payload Effecti (so o sub-campo, via JSON path, para nao trafegar o payload
 * inteiro). itensEdital ausente => lista vazia (aviso sem destaque).
 */
async function loadAvisoMeta(db: ServiceClient, avisoId: string): Promise<AvisoMeta | null> {
  const { data, error } = await db
    .from("avisos")
    .select("effecti_id, itens_effecti:payload_bruto->itensEdital")
    .eq("id", avisoId)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler aviso: ${error.message}`);
  }
  const eid = (data?.effecti_id ?? "").trim();
  if (eid === "") return null;
  const raw = (data as { itens_effecti?: unknown }).itens_effecti;
  const itensEffecti = Array.isArray(raw) ? (raw as ItensEditalRow[]) : [];
  return { effectiId: eid, itensEffecti };
}

/**
 * Marca cada item com `effecti` cruzando contra os itens destacados pelo Effecti.
 * Best-effort: por numero de item OU por descricao normalizada. O destaque do
 * Effecti usa a numeracao do portal, que nem sempre coincide com a extracao; a
 * descricao recupera os casos de numero divergente.
 */
function marcarEffecti(itens: ItemLicitacao[], itensEffecti: ItensEditalRow[]): void {
  if (itensEffecti.length === 0) return;
  const numSet = new Set<number>();
  const descSet = new Set<string>();
  for (const e of itensEffecti) {
    const n = typeof e.item === "number" ? e.item : Number(e.item);
    if (Number.isInteger(n)) numSet.add(n);
    const d = normDesc(e.produtoLicitadoSemTags);
    if (d.length > 0) descSet.add(d);
  }
  for (const it of itens) {
    const num = it.item_numero && /^[0-9]+$/.test(it.item_numero)
      ? Number(it.item_numero)
      : null;
    const porNumero = num !== null && numSet.has(num);
    const porDescricao = descSet.has(normDesc(it.descricao));
    it.effecti = porNumero || porDescricao;
  }
}

/** documento_ids com texto aproveitavel vinculados ao effecti_id (dedup). */
async function loadDocIds(db: ServiceClient, effectiId: string): Promise<string[]> {
  const vinculos = await fetchAllRows<VinculoRow>("documento_vinculos", (from, to) =>
    db
      .from("documento_vinculos")
      .select("documento_id")
      .eq("fonte", "effecti")
      .eq("registro_origem_id", effectiId)
      .in("status_extracao", STATUS_EXTRACAO_COM_TEXTO)
      .range(from, to));
  const set = new Set<string>();
  for (const v of vinculos) {
    if (v.documento_id) set.add(v.documento_id);
  }
  return [...set];
}

/** Metadados (nome + itens_status) dos documentos. */
async function loadDocumentos(db: ServiceClient, docIds: string[]): Promise<DocumentoFila[]> {
  const { data, error } = await db
    .from("documentos")
    .select("id, nome_arquivo, itens_status")
    .in("id", docIds);
  if (error) {
    throw new Error(`falha ao ler documentos: ${error.message}`);
  }
  return ((data ?? []) as DocumentoMetaRow[])
    .map((row) => ({
      documento_id: row.id,
      nome_arquivo: row.nome_arquivo ?? null,
      itens_status: row.itens_status ?? "pendente",
    }))
    .sort((a, b) => (a.nome_arquivo ?? "").localeCompare(b.nome_arquivo ?? ""));
}

/** Itens literais (documento_itens), ordenados por documento/lista/ordem. */
async function loadItens(db: ServiceClient, docIds: string[]): Promise<ItemLicitacao[]> {
  const rows = await fetchAllRows<ItemRow>("documento_itens", (from, to) =>
    db
      .from("documento_itens")
      .select(
        "id, documento_id, lista_origem, fonte_descricao, item_numero, lote, " +
          "descricao, unidade, quantidade, preco_referencia, ordem",
      )
      .in("documento_id", docIds)
      .order("documento_id", { ascending: true })
      .order("lista_origem", { ascending: true })
      .order("ordem", { ascending: true })
      .range(from, to));
  return rows.map((row) => ({
    id: row.id,
    documento_id: row.documento_id,
    lista_origem: row.lista_origem ?? "principal",
    fonte_descricao: row.fonte_descricao ?? "tecnica",
    item_numero: row.item_numero ?? null,
    lote: row.lote ?? null,
    descricao: row.descricao,
    unidade: row.unidade ?? null,
    quantidade: typeof row.quantidade === "number" ? row.quantidade : null,
    preco_referencia: typeof row.preco_referencia === "number" ? row.preco_referencia : null,
    ordem: typeof row.ordem === "number" ? row.ordem : null,
    effecti: false,
  }));
}

/** Matches item x produto deste aviso (triagem_item_matches). Pagina (recall
 *  total): um edital com >1000 itens cotaveis nao pode truncar no teto PostgREST. */
async function loadMatches(db: ServiceClient, avisoId: string): Promise<ItemMatch[]> {
  const rows = await fetchAllRows<{
    documento_item_id: string;
    produto_id: string | null;
    sku_id: string | null;
    produto_nome: string | null;
    score: number | null;
  }>("triagem_item_matches", (from, to) =>
    db
      .from("triagem_item_matches")
      .select("documento_item_id, produto_id, sku_id, produto_nome, score")
      .eq("aviso_id", avisoId)
      .range(from, to));
  // Resolve o codigo_sku legivel (ex: FLM-OURO-30X50) dos sku_id que casaram.
  const skuIds = [...new Set(rows.map((r) => r.sku_id).filter((x): x is string => Boolean(x)))];
  const codigoPorSku = new Map<string, string>();
  if (skuIds.length > 0) {
    const { data, error } = await db
      .from("produto_skus")
      .select("id, codigo_sku")
      .in("id", skuIds);
    if (error) throw new Error(`falha ao ler produto_skus: ${error.message}`);
    for (const r of (data ?? []) as { id: string; codigo_sku: string | null }[]) {
      if (r.codigo_sku) codigoPorSku.set(r.id, r.codigo_sku);
    }
  }
  return rows.map((m) => ({
    documento_item_id: m.documento_item_id,
    produto_id: m.produto_id ?? null,
    sku_id: m.sku_id ?? null,
    codigo_sku: m.sku_id ? (codigoPorSku.get(m.sku_id) ?? null) : null,
    produto_nome: m.produto_nome ?? null,
    score: typeof m.score === "number" ? m.score : null,
  }));
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");

    // Autorizacao na borda: 401 sem sessao, 403 fora da allowlist.
    await requireAuthorizedUser(req);

    const url = new URL(req.url);
    const avisoId = (url.searchParams.get("aviso_id") ?? "").trim();
    if (avisoId === "") {
      return jsonResponse({ error: "aviso_id obrigatorio" }, 400);
    }

    const db = createServiceClient();

    const meta = await loadAvisoMeta(db, avisoId);
    if (meta === null) {
      // Aviso sem effecti_id (ou inexistente): sem documentos vinculados.
      return jsonResponse({ documentos: [], itens: [], matches: [] }, 200);
    }

    const docIds = await loadDocIds(db, meta.effectiId);
    if (docIds.length === 0) {
      return jsonResponse({ documentos: [], itens: [], matches: [] }, 200);
    }

    const [documentos, itens, matches] = await Promise.all([
      loadDocumentos(db, docIds),
      loadItens(db, docIds),
      loadMatches(db, avisoId),
    ]);

    // Marca quais itens o Effecti destacou (hint de prioridade no cockpit).
    marcarEffecti(itens, meta.itensEffecti);

    return jsonResponse({ documentos, itens, matches }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
