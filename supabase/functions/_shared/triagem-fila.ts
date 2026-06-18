// =====================================================================
// _shared/triagem-fila.ts
// Montagem do PAYLOAD MINIMO da FILA de triagem (Caminho 2: o servidor NAO
// chama LLM, apenas entrega trabalho ao Lion). Por aviso elegivel monta:
//   - trechos_edital      (aviso_chunks.conteudo + aviso_arquivos.texto_extraido)
//   - produtos_candidatos (busca semantica escopo 'produto-cotacao', MASCARADOS)
//   - few_shot            (triagem_exemplos.ativo, ate k por similaridade + recencia)
//   - regras_duras        (triagem_regras ativas: fora_de_ramo / termo_produto)
// e, no topo, o objeto `agente` versionado (triagem_agente_config).
//
// Selecao de avisos (E6/E7, RF-01..RF-04):
//   status_indexacao = 'indexado' E reabilitado = false E ainda nao triados
//   (triagem_veredito IS NULL). A re-triagem por mudanca de conteudo
//   (conteudo_hash diferente do usado na ultima triagem) e materializada
//   upstream: o pipeline de re-coleta/re-indexacao zera triagem_veredito quando
//   o conteudo muda, fazendo o aviso voltar a esta fila pelo MESMO filtro
//   (triagem_veredito IS NULL). Ordenacao FIFO por data de captura ascendente.
//
// SEC-4 / RNF-01: o payload NUNCA contem conteudo_verbatim, payload_bruto,
// custos, margens, BOM, hashes, tokens nem o edital integral. trechos_edital
// sao SEGMENTOS limitados (cap de quantidade e de caracteres); produtos vem
// mascarados (apenas produto_id, nome e similaridade).
//
// Nota sobre busca_semantica_chunks(p_aviso_id): a RPC origem-aware retorna o
// `conteudo_verbatim` agregado do aviso (nao o texto por chunk), inadequado
// para trechos limitados sob SEC-4. Por isso os trechos sao montados a partir
// dos SEGMENTOS ja indexados (aviso_chunks.conteudo) — exatamente o material
// sobre o qual a RPC opera — garantindo limite e conformidade.
// =====================================================================

import { createServiceClient } from "./supabase.ts";
import { createEmbeddingProvider, EmbeddingError, type EmbeddingProvider } from "./embeddings.ts";
import { getEnv } from "./env.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Escopo fixo do indice de memoria do catalogo de produtos (RF-24/RF-25). */
const PRODUTO_CHUNK_ESCOPO = "produto-cotacao" as const;

/** Limites de montagem (defense in depth contra payload inflado / SEC-4). */
export const FILA_DEFAULT_LIMITE = 20;
export const FILA_MAX_LIMITE = 50;
const MAX_TRECHOS = 6;
const MAX_TRECHO_CHARS = 600;
const MAX_TEXTO_EXTRAIDO_TRECHOS = 2;
const MAX_PRODUTOS_CANDIDATOS = 5;
const PRODUTOS_BUSCA_K = 8;
const MAX_QUERY_CHARS = 1_500;
const FEWSHOT_BANK_CAP = 200;

/** Objeto agente versionado entregue no topo da FILA (E15). */
export interface AgentePayload {
  ativo: boolean;
  nome: string;
  persona_prompt: string;
  ferramentas: string[];
  versao: number;
}

/** Produto candidato MASCARADO (sem custo/margem/BOM) — SEC-4. */
export interface ProdutoCandidato {
  produto_id: string;
  nome: string;
  similaridade: number;
}

/** Exemplo few-shot rotulado (sem embedding nem ids internos). */
export interface FewShotExemplo {
  texto: string;
  veredito_rotulado: string | null;
}

/** Regras duras ativas agrupadas por tipo. */
export interface RegrasDuras {
  fora_de_ramo: string[];
  termo_produto: string[];
}

/** Item da FILA no contrato 3.2.1. */
export interface TriagemFilaItem {
  aviso_id: string;
  objeto: string;
  orgao: string;
  uf: string;
  data: string | null;
  trechos_edital: string[];
  produtos_candidatos: ProdutoCandidato[];
  few_shot: FewShotExemplo[];
  k_few_shot: number;
  regras_duras: RegrasDuras;
}

/** Resultado completo da FILA (agente omitido quando ativo = false). */
export interface TriagemFilaResult {
  agente?: AgentePayload;
  itens: TriagemFilaItem[];
  next_cursor: string | null;
}

export interface BuildTriagemFilaParams {
  limite: number;
  cursor: string | null;
  /** Provider de embeddings injetavel (testes); senao resolve o padrao. */
  provider?: EmbeddingProvider;
}

/** Normaliza `limite` da query: default 20, faixa [1, 50] (cap, nao rejeita). */
export function normalizeFilaLimite(raw: string | null): number {
  if (raw === null) return FILA_DEFAULT_LIMITE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    return FILA_DEFAULT_LIMITE;
  }
  return Math.min(parsed, FILA_MAX_LIMITE);
}

// ---------------------------------------------------------------------
// Tipos internos de linhas (snake_case do banco).
// ---------------------------------------------------------------------
interface AvisoRow {
  id: string;
  objeto: string;
  orgao: string;
  data_publicacao: string | null;
  data_captura: string;
  uf_direct: string | null;
  uf_estado: string | null;
  uf_sigla: string | null;
}

interface ChunkRow {
  aviso_id: string;
  ordem: number | null;
  conteudo: string;
}

interface ArquivoRow {
  aviso_id: string;
  texto_extraido: string | null;
}

interface ExemploRow {
  id: string;
  texto: string;
  veredito_rotulado: string | null;
  embedding: unknown;
  criado_em: string;
}

interface BuscaRow {
  registro_id: string | null;
  similaridade: number | null;
}

/**
 * Monta o payload completo da FILA: agente + itens + next_cursor.
 * Toda a leitura roda com service_role (a RPC e SECURITY DEFINER e a borda ja
 * autorizou). Erros de banco viram excecao para o handler converter em 500.
 */
export async function buildTriagemFila(
  params: BuildTriagemFilaParams,
): Promise<TriagemFilaResult> {
  const db = createServiceClient();

  // 1) Insumos globais (uma leitura cada, reusados por todos os itens).
  const [agente, kFewShot, regrasDuras, fewShotBank] = await Promise.all([
    loadAgente(db),
    loadKFewShot(db),
    loadRegrasDuras(db),
    loadFewShotBank(db),
  ]);

  // 2) Avisos elegiveis (FIFO por data_captura asc; keyset por cursor).
  const avisos = await selectAvisosElegiveis(db, params.limite, params.cursor);
  if (avisos.length === 0) {
    return { ...(agente.ativo ? { agente } : {}), itens: [], next_cursor: null };
  }

  const avisoIds = avisos.map((a) => a.id);

  // 3) Trechos por aviso (segmentos indexados + texto extraido), em lote.
  const [chunksByAviso, textoByAviso] = await Promise.all([
    loadChunksByAviso(db, avisoIds),
    loadTextoExtraidoByAviso(db, avisoIds),
  ]);

  // 4) Embedding do texto de cada aviso (objeto + trechos), em UM lote. Em
  //    degradacao (provider ausente/indisponivel) seguimos sem produtos e com
  //    few-shot por recencia: a FILA continua entregando trabalho.
  const queryTexts = avisos.map((a) => buildQueryText(a.objeto, chunksByAviso.get(a.id) ?? []));
  const vectors = await embedQueries(queryTexts, params.provider);

  // 5) Monta cada item.
  const itens: TriagemFilaItem[] = [];
  for (let i = 0; i < avisos.length; i++) {
    const aviso = avisos[i];
    const vector = vectors[i] ?? null;
    const trechos = buildTrechos(
      chunksByAviso.get(aviso.id) ?? [],
      textoByAviso.get(aviso.id) ?? [],
    );
    const produtosCandidatos = vector ? await buscarProdutos(db, vector) : [];
    const fewShot = selectFewShot(fewShotBank, vector, kFewShot);

    itens.push({
      aviso_id: aviso.id,
      objeto: aviso.objeto,
      orgao: aviso.orgao,
      uf: resolveUf(aviso),
      data: aviso.data_publicacao ?? aviso.data_captura ?? null,
      trechos_edital: trechos,
      produtos_candidatos: produtosCandidatos,
      few_shot: fewShot,
      k_few_shot: kFewShot,
      regras_duras: regrasDuras,
    });
  }

  // 6) Cursor: aponta para o ultimo aviso quando a pagina veio cheia.
  const nextCursor = itens.length === params.limite ? itens[itens.length - 1].aviso_id : null;

  return { ...(agente.ativo ? { agente } : {}), itens, next_cursor: nextCursor };
}

// ---------------------------------------------------------------------
// Insumos globais.
// ---------------------------------------------------------------------

async function loadAgente(db: ServiceClient): Promise<AgentePayload> {
  const { data, error } = await db
    .from("triagem_agente_config")
    .select("ativo, nome, persona_prompt, ferramentas, versao")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler triagem_agente_config: ${error.message}`);
  }
  if (!data) {
    // Sem singleton (seed ausente): trata como agente inativo (omitido).
    return { ativo: false, nome: "", persona_prompt: "", ferramentas: [], versao: 0 };
  }
  return {
    ativo: data.ativo === true,
    nome: String(data.nome ?? ""),
    persona_prompt: String(data.persona_prompt ?? ""),
    ferramentas: Array.isArray(data.ferramentas)
      ? (data.ferramentas as unknown[]).map((f) => String(f))
      : [],
    versao: typeof data.versao === "number" ? data.versao : 0,
  };
}

async function loadKFewShot(db: ServiceClient): Promise<number> {
  const { data, error } = await db
    .from("config_automacao")
    .select("k_few_shot")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler config_automacao: ${error.message}`);
  }
  const k = typeof data?.k_few_shot === "number" ? data.k_few_shot : 8;
  return Math.min(Math.max(0, Math.trunc(k)), 50);
}

async function loadRegrasDuras(db: ServiceClient): Promise<RegrasDuras> {
  const { data, error } = await db
    .from("triagem_regras")
    .select("tipo, termo")
    .eq("ativo", true);
  if (error) {
    throw new Error(`falha ao ler triagem_regras: ${error.message}`);
  }
  const foraDeRamo: string[] = [];
  const termoProduto: string[] = [];
  for (const row of (data ?? []) as { tipo: string; termo: string }[]) {
    if (row.tipo === "fora_de_ramo") foraDeRamo.push(row.termo);
    else if (row.tipo === "termo_produto") termoProduto.push(row.termo);
  }
  return { fora_de_ramo: foraDeRamo, termo_produto: termoProduto };
}

async function loadFewShotBank(db: ServiceClient): Promise<ExemploRow[]> {
  const { data, error } = await db
    .from("triagem_exemplos")
    .select("id, texto, veredito_rotulado, embedding, criado_em")
    .eq("ativo", true)
    .order("criado_em", { ascending: false })
    .limit(FEWSHOT_BANK_CAP);
  if (error) {
    throw new Error(`falha ao ler triagem_exemplos: ${error.message}`);
  }
  return (data ?? []) as ExemploRow[];
}

// ---------------------------------------------------------------------
// Selecao de avisos elegiveis (FIFO + keyset).
// ---------------------------------------------------------------------

async function selectAvisosElegiveis(
  db: ServiceClient,
  limite: number,
  cursor: string | null,
): Promise<AvisoRow[]> {
  // Campos minimos. uf nao e coluna -> extraido do payload_bruto via arrow
  // (top-level, sem trafegar o payload inteiro). data_captura ordena a FIFO.
  const selectCols = "id, objeto, orgao, data_publicacao, data_captura, " +
    "uf_direct:payload_bruto->>uf, uf_estado:payload_bruto->>estado, " +
    "uf_sigla:payload_bruto->>siglaUf";

  let query = db
    .from("avisos")
    .select(selectCols)
    .eq("status_indexacao", "indexado")
    .eq("reabilitado", false)
    .is("triagem_veredito", null);

  // Keyset por cursor (uuid): retoma apos o aviso apontado, na ordem FIFO
  // (data_captura asc, id asc). Cursor desconhecido => recomeca do inicio.
  if (cursor) {
    const { data: cursorRow } = await db
      .from("avisos")
      .select("data_captura")
      .eq("id", cursor)
      .maybeSingle();
    const cursorCaptura = cursorRow?.data_captura as string | undefined;
    if (cursorCaptura) {
      query = query.or(
        `data_captura.gt."${cursorCaptura}",` +
          `and(data_captura.eq."${cursorCaptura}",id.gt."${cursor}")`,
      );
    }
  }

  const { data, error } = await query
    .order("data_captura", { ascending: true })
    .order("id", { ascending: true })
    .limit(limite);

  if (error) {
    throw new Error(`falha ao selecionar avisos da fila: ${error.message}`);
  }
  // Os aliases por arrow-operator (payload_bruto->>...) impedem a inferencia
  // estatica do PostgREST (cai em GenericStringError); cast via unknown.
  return (data ?? []) as unknown as AvisoRow[];
}

// ---------------------------------------------------------------------
// Trechos do edital (segmentos indexados + texto extraido), em lote.
// ---------------------------------------------------------------------

async function loadChunksByAviso(
  db: ServiceClient,
  avisoIds: string[],
): Promise<Map<string, ChunkRow[]>> {
  const { data, error } = await db
    .from("aviso_chunks")
    .select("aviso_id, ordem, conteudo")
    .in("aviso_id", avisoIds)
    .order("aviso_id", { ascending: true })
    .order("ordem", { ascending: true });
  if (error) {
    throw new Error(`falha ao ler aviso_chunks: ${error.message}`);
  }
  const map = new Map<string, ChunkRow[]>();
  for (const row of (data ?? []) as ChunkRow[]) {
    const list = map.get(row.aviso_id) ?? [];
    if (list.length < MAX_TRECHOS) {
      list.push(row);
      map.set(row.aviso_id, list);
    }
  }
  return map;
}

async function loadTextoExtraidoByAviso(
  db: ServiceClient,
  avisoIds: string[],
): Promise<Map<string, string[]>> {
  // Fallback de trechos: usado sobretudo quando o aviso nao tem chunks. Limita
  // a quantidade de arquivos e clipa cada texto (SEC-4: nunca o edital integral).
  const { data, error } = await db
    .from("aviso_arquivos")
    .select("aviso_id, texto_extraido")
    .in("aviso_id", avisoIds)
    .eq("status_tratamento", "ok")
    .not("texto_extraido", "is", null);
  if (error) {
    throw new Error(`falha ao ler aviso_arquivos: ${error.message}`);
  }
  const map = new Map<string, string[]>();
  for (const row of (data ?? []) as ArquivoRow[]) {
    const texto = (row.texto_extraido ?? "").trim();
    if (texto === "") continue;
    const list = map.get(row.aviso_id) ?? [];
    if (list.length < MAX_TEXTO_EXTRAIDO_TRECHOS) {
      list.push(clip(texto, MAX_TRECHO_CHARS));
      map.set(row.aviso_id, list);
    }
  }
  return map;
}

function buildTrechos(chunks: ChunkRow[], textoExtraido: string[]): string[] {
  const trechos: string[] = [];
  for (const c of chunks) {
    const t = (c.conteudo ?? "").trim();
    if (t !== "") trechos.push(clip(t, MAX_TRECHO_CHARS));
    if (trechos.length >= MAX_TRECHOS) break;
  }
  // Sem segmentos indexados: recorre ao texto extraido (clipado) como trecho.
  if (trechos.length === 0) {
    for (const t of textoExtraido) {
      if (t !== "") trechos.push(t);
      if (trechos.length >= MAX_TRECHOS) break;
    }
  }
  return trechos;
}

// ---------------------------------------------------------------------
// Embedding em lote + produtos candidatos mascarados.
// ---------------------------------------------------------------------

function buildQueryText(objeto: string, chunks: ChunkRow[]): string {
  const partes = [objeto?.trim() ?? ""];
  for (const c of chunks.slice(0, 2)) {
    const t = (c.conteudo ?? "").trim();
    if (t !== "") partes.push(t);
  }
  return clip(partes.filter((p) => p !== "").join("\n"), MAX_QUERY_CHARS);
}

/**
 * Gera o embedding de cada query em UM lote. Degradacao graciosa: sem provider
 * configurado ou em falha do provider, retorna vetores nulos (a FILA segue sem
 * produtos candidatos e com few-shot por recencia).
 */
async function embedQueries(
  queryTexts: string[],
  injected?: EmbeddingProvider,
): Promise<(number[] | null)[]> {
  const nulls = queryTexts.map(() => null);
  if (!injected && !(getEnv().embeddingsEndpoint ?? "").trim()) {
    return nulls;
  }
  const provider = injected ?? createEmbeddingProvider();
  try {
    const vectors = await provider.embed(queryTexts);
    return queryTexts.map((_, i) => {
      const v = vectors[i];
      return Array.isArray(v) && v.length > 0 ? v : null;
    });
  } catch (err) {
    if (err instanceof EmbeddingError) {
      console.warn(`[triagem-fila] embeddings indisponiveis; degradando: ${err.message}`);
      return nulls;
    }
    throw err;
  }
}

async function buscarProdutos(
  db: ServiceClient,
  vector: number[],
): Promise<ProdutoCandidato[]> {
  const { data, error } = await db.rpc("busca_semantica_chunks", {
    p_embedding: vector,
    p_limite: PRODUTOS_BUSCA_K,
    p_escopo: PRODUTO_CHUNK_ESCOPO,
  });
  if (error) {
    // Falha de produtos nao derruba a FILA: entrega item sem candidatos.
    console.warn(`[triagem-fila] busca de produtos falhou: ${error.message}`);
    return [];
  }

  // registro_id (escopo produto-cotacao) = produto_skus.id. Resolve sku ->
  // produto (id + nome) e deduplica por produto mantendo a maior similaridade.
  const rows = ((data ?? []) as BuscaRow[]).filter((r) => r.registro_id);
  const bestBySku = new Map<string, number>();
  for (const r of rows) {
    const sim = typeof r.similaridade === "number" ? r.similaridade : 0;
    const prev = bestBySku.get(r.registro_id as string) ?? -1;
    if (sim > prev) bestBySku.set(r.registro_id as string, sim);
  }
  const skuIds = [...bestBySku.keys()];
  if (skuIds.length === 0) return [];

  const { data: skus, error: skuErr } = await db
    .from("produto_skus")
    .select("id, produto_id, produtos(id, nome)")
    .in("id", skuIds);
  if (skuErr) {
    console.warn(`[triagem-fila] resolucao de produtos falhou: ${skuErr.message}`);
    return [];
  }

  // Mapeia sku -> { produto_id, nome } e agrega por produto (maior similaridade).
  const bestByProduto = new Map<string, ProdutoCandidato>();
  for (const sku of (skus ?? []) as SkuJoinRow[]) {
    const produto = Array.isArray(sku.produtos) ? sku.produtos[0] : sku.produtos;
    const produtoId = produto?.id ?? sku.produto_id;
    const nome = produto?.nome ?? "";
    if (!produtoId) continue;
    const sim = bestBySku.get(sku.id) ?? 0;
    const prev = bestByProduto.get(produtoId);
    if (!prev || sim > prev.similaridade) {
      bestByProduto.set(produtoId, { produto_id: produtoId, nome, similaridade: sim });
    }
  }

  return [...bestByProduto.values()]
    .sort((a, b) => b.similaridade - a.similaridade)
    .slice(0, MAX_PRODUTOS_CANDIDATOS);
}

interface SkuJoinRow {
  id: string;
  produto_id: string;
  produtos: { id: string; nome: string } | { id: string; nome: string }[] | null;
}

// ---------------------------------------------------------------------
// Few-shot: ativos, ordenados por similaridade ao aviso + recencia, ate k.
// ---------------------------------------------------------------------

function selectFewShot(
  bank: ExemploRow[],
  vector: number[] | null,
  k: number,
): FewShotExemplo[] {
  if (k <= 0 || bank.length === 0) return [];

  // O banco ja vem ordenado por recencia desc. Com vetor do aviso, reordena
  // por similaridade (desc) e usa a recencia como desempate (ordem de chegada).
  const ranked = bank.map((ex, idx) => {
    const exVec = vector ? parseVector(ex.embedding) : null;
    const sim = vector && exVec ? cosineSimilarity(vector, exVec) : 0;
    return { ex, sim, idx };
  });

  ranked.sort((a, b) => (b.sim - a.sim) || (a.idx - b.idx));

  return ranked.slice(0, k).map(({ ex }) => ({
    texto: ex.texto,
    veredito_rotulado: ex.veredito_rotulado ?? null,
  }));
}

// ---------------------------------------------------------------------
// Utilitarios.
// ---------------------------------------------------------------------

function resolveUf(aviso: AvisoRow): string {
  const candidatos = [aviso.uf_direct, aviso.uf_estado, aviso.uf_sigla];
  for (const c of candidatos) {
    const v = (c ?? "").trim();
    if (v !== "") return v;
  }
  return "";
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/** Converte o embedding retornado pelo PostgREST (string "[...]" ou array). */
function parseVector(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    const nums = raw.map((n) => Number(n));
    return nums.every((n) => Number.isFinite(n)) ? nums : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("[")) return null;
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      if (!Array.isArray(arr)) return null;
      const nums = arr.map((n) => Number(n));
      return nums.every((n) => Number.isFinite(n)) ? nums : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
