// =====================================================================
// _shared/triagem-fila.ts
// Montagem do PAYLOAD MINIMO da FILA de triagem (Caminho 2: o servidor NAO
// chama LLM, apenas entrega trabalho ao Lion). Por aviso elegivel monta:
//   - trechos_edital   (aviso_chunks.conteudo + aviso_arquivos.texto_extraido)
//   - documentos       (documentos vinculados ao aviso + itens_status de cada um)
//   - itens_licitacao  (LISTA DE ITENS extraida — documento_itens — por documento)
//   - few_shot         (triagem_exemplos.ativo, ate k por recencia)
//   - regras_duras     (triagem_regras ativas: fora_de_ramo / termo_produto)
// e, no topo, o objeto `agente` versionado (triagem_agente_config).
//
// RECALL POR ITEM (2026-06-18): o servidor NAO cruza mais o edital contra o
// catalogo. Em vez de `produtos_candidatos`, entrega a LISTA DE ITENS literal
// do edital/anexos (documento_itens) e a propria Lia cruza com o catalogo e
// consulta a politica de participacao por produto que identificar. "Entregar a
// lista e barato; analisar o edital inteiro e caro" — a fila SO LE
// documento_itens; a extracao (1x/doc, armazenada) e feita pela Lia.
//
// Estado de extracao por documento (itens_status): a fila expoe documentos +
// itens_status para a Lia saber o que ainda falta extrair. Quando um documento
// vem 'pendente', a Lia le o texto JA extraido, estrutura os itens e grava via
// documento_itens_gravar — depois triada. Extracao e dedup-global (por
// documento), reaproveitada por todos os avisos que compartilham o edital.
//
// Selecao de avisos (E6/E7, RF-01..RF-04):
//   status_indexacao = 'indexado' E reabilitado = false E ainda nao triados
//   (triagem_veredito IS NULL). A re-triagem por mudanca de conteudo e
//   materializada upstream (o pipeline zera triagem_veredito quando o conteudo
//   muda). Ordenacao FIFO por data de captura ascendente.
//
// SEC-4 / RNF-01: o payload NUNCA contem conteudo_verbatim, payload_bruto,
// custos, margens, BOM, hashes nem tokens. trechos_edital sao SEGMENTOS
// limitados (cap de quantidade e de caracteres). itens_licitacao e conteudo de
// NEGOCIO (descricao literal do item, quantidade, unidade, preco de referencia)
// — fronteira SOM permite; custo/margem/BOM seguem fora.
// =====================================================================

import { createServiceClient } from "./supabase.ts";
import { type JanelaTriagem, janelaOrFilters, loadJanelaTriagem } from "./triagem-janela.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Limites de montagem (defense in depth contra payload inflado / SEC-4). */
export const FILA_DEFAULT_LIMITE = 20;
export const FILA_MAX_LIMITE = 50;
const MAX_TRECHOS = 6;
const MAX_TRECHO_CHARS = 600;
const MAX_TEXTO_EXTRAIDO_TRECHOS = 2;
const FEWSHOT_BANK_CAP = 200;

/**
 * Setor da base de conhecimento entregue nesta fila. A triagem e do dominio
 * de licitacao; o conhecimento e generico por `setor` (cockpit), e aqui
 * carregamos a fatia desse setor. Outros subagentes (outros setores) reusam
 * a mesma tabela com outra chave.
 */
const TRIAGEM_SETOR = "licitacao";
const CONHECIMENTOS_CAP = 50;

/**
 * Estados de extracao de TEXTO (documento_vinculos.status_extracao) que tem
 * texto aproveitavel para extracao de itens. precisa_ocr incluido de proposito:
 * editais escaneados/grandes podem ter texto parcial. pendente/erro/inobtenivel/
 * ignorado ficam fora (sem texto valido para a Lia estruturar itens).
 */
const STATUS_EXTRACAO_COM_TEXTO = ["extraido", "herdado", "precisa_ocr"];

/**
 * PostgREST limita a resposta a 1000 linhas; sem paginar, vinculos/itens em
 * volume sao truncados em SILENCIO — perda de documentos/itens que viola o
 * RECALL TOTAL. fetchAllRows pagina via .range() ate esgotar.
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

/** Objeto agente versionado entregue no topo da FILA (E15). */
export interface AgentePayload {
  ativo: boolean;
  nome: string;
  persona_prompt: string;
  /**
   * Metodo operacional do MODO (cockpit-driven): os passos que o subagente
   * executa. Fica no banco (versionado) e nao no shell do Lion, para ser
   * administrado pelo cockpit sem rebuild/reboot. Vazio = sem metodo definido.
   */
  instrucoes_operacionais: string;
  versao: number;
}

/**
 * Item da base de conhecimento de dominio entregue no topo da FILA. Generico
 * por setor, versionado e administrado no cockpit (sem segredo). A Lia ancora
 * o raciocinio nestes textos.
 */
export interface ConhecimentoPayload {
  titulo: string;
  conteudo: string;
}

/** Documento vinculado ao aviso + estado da extracao de itens (lazy). */
export interface DocumentoFila {
  documento_id: string;
  nome_arquivo: string | null;
  /** pendente | extraido | sem_itens | erro | inobtenivel | ignorado. */
  itens_status: string;
}

/** Item de licitacao literal (documento_itens) — recall total, sem fusao. */
export interface ItemLicitacao {
  /** id do documento_itens — o subagente o devolve no match (triagem_item_matches). */
  id: string;
  documento_id: string;
  /** Rotulo da lista de origem (ex.: 'principal', 'anexo TR'); listas convivem. */
  lista_origem: string;
  /** 'tecnica' (descricao confiavel) ou 'portal' (generica, nao confiavel). */
  fonte_descricao: string;
  item_numero: string | null;
  lote: string | null;
  /** Descricao INTEGRAL/literal do item (sem truncar) — recall total. */
  descricao: string;
  unidade: string | null;
  quantidade: number | null;
  /** Preco de referencia UNITARIO (nullable). */
  preco_referencia: number | null;
  ordem: number | null;
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

/** Item da FILA no contrato 3.2.1 (recall por item). */
export interface TriagemFilaItem {
  aviso_id: string;
  objeto: string;
  orgao: string;
  uf: string;
  data: string | null;
  trechos_edital: string[];
  documentos: DocumentoFila[];
  itens_licitacao: ItemLicitacao[];
  few_shot: FewShotExemplo[];
  k_few_shot: number;
  regras_duras: RegrasDuras;
}

/** Resultado completo da FILA (agente omitido quando ativo = false). */
export interface TriagemFilaResult {
  agente?: AgentePayload;
  conhecimentos: ConhecimentoPayload[];
  itens: TriagemFilaItem[];
  next_cursor: string | null;
}

export interface BuildTriagemFilaParams {
  limite: number;
  cursor: string | null;
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
  effecti_id: string | null;
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
  criado_em: string;
}

interface VinculoRow {
  registro_origem_id: string;
  documento_id: string;
}

interface ConhecimentoRow {
  titulo: string | null;
  conteudo: string;
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

/**
 * Monta o payload completo da FILA: agente + itens + next_cursor.
 * Toda a leitura roda com service_role (a borda ja autorizou). Erros de banco
 * viram excecao para o handler converter em 500.
 */
export async function buildTriagemFila(
  params: BuildTriagemFilaParams,
): Promise<TriagemFilaResult> {
  const db = createServiceClient();

  // 1) Insumos globais (uma leitura cada, reusados por todos os itens).
  const [agente, conhecimentos, kFewShot, regrasDuras, fewShotBank, janela] = await Promise.all([
    loadAgente(db),
    loadConhecimentos(db),
    loadKFewShot(db),
    loadRegrasDuras(db),
    loadFewShotBank(db),
    loadJanelaTriagem(db),
  ]);

  // 2) Avisos elegiveis (FIFO por data_captura asc; keyset por cursor; janela).
  const avisos = await selectAvisosElegiveis(db, params.limite, params.cursor, janela);
  if (avisos.length === 0) {
    return { ...(agente.ativo ? { agente } : {}), conhecimentos, itens: [], next_cursor: null };
  }

  const avisoIds = avisos.map((a) => a.id);

  // 3) Trechos por aviso (segmentos indexados + texto extraido), em lote.
  const [chunksByAviso, textoByAviso] = await Promise.all([
    loadChunksByAviso(db, avisoIds),
    loadTextoExtraidoByAviso(db, avisoIds),
  ]);

  // 4) Documentos vinculados (por effecti_id) e seus itens extraidos, em lote.
  //    A Lia recebe a lista de itens (documento_itens) e os documentos com
  //    itens_status para extrair os 'pendente' sob demanda. SEM cross-join.
  const { docsByAviso, itensByDocumento } = await loadDocumentosEItens(db, avisos);

  // 5) Monta cada item.
  const itens: TriagemFilaItem[] = [];
  for (const aviso of avisos) {
    const trechos = buildTrechos(
      chunksByAviso.get(aviso.id) ?? [],
      textoByAviso.get(aviso.id) ?? [],
    );
    const documentos = docsByAviso.get(aviso.id) ?? [];
    const itensLicitacao: ItemLicitacao[] = [];
    for (const doc of documentos) {
      for (const item of itensByDocumento.get(doc.documento_id) ?? []) {
        itensLicitacao.push(item);
      }
    }
    const fewShot = selectFewShot(fewShotBank, kFewShot);

    itens.push({
      aviso_id: aviso.id,
      objeto: aviso.objeto,
      orgao: aviso.orgao,
      uf: resolveUf(aviso),
      data: aviso.data_publicacao ?? aviso.data_captura ?? null,
      trechos_edital: trechos,
      documentos,
      itens_licitacao: itensLicitacao,
      few_shot: fewShot,
      k_few_shot: kFewShot,
      regras_duras: regrasDuras,
    });
  }

  // 6) Cursor: aponta para o ultimo aviso quando a pagina veio cheia.
  const nextCursor = itens.length === params.limite ? itens[itens.length - 1].aviso_id : null;

  return { ...(agente.ativo ? { agente } : {}), conhecimentos, itens, next_cursor: nextCursor };
}

// ---------------------------------------------------------------------
// Insumos globais.
// ---------------------------------------------------------------------

async function loadAgente(db: ServiceClient): Promise<AgentePayload> {
  const { data, error } = await db
    .from("triagem_agente_config")
    .select("ativo, nome, persona_prompt, instrucoes_operacionais, versao")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler triagem_agente_config: ${error.message}`);
  }
  if (!data) {
    // Sem singleton (seed ausente): trata como agente inativo (omitido).
    return {
      ativo: false,
      nome: "",
      persona_prompt: "",
      instrucoes_operacionais: "",
      versao: 0,
    };
  }
  return {
    ativo: data.ativo === true,
    nome: String(data.nome ?? ""),
    persona_prompt: String(data.persona_prompt ?? ""),
    instrucoes_operacionais: String(data.instrucoes_operacionais ?? ""),
    versao: typeof data.versao === "number" ? data.versao : 0,
  };
}

/**
 * Le a base de conhecimento ativa do setor da triagem, na ordem definida no
 * cockpit (ordem asc, depois criacao). Cap defensivo de quantidade. Conteudo
 * de dominio (sem segredo) — entregue integral, a Lia ancora nele.
 */
async function loadConhecimentos(db: ServiceClient): Promise<ConhecimentoPayload[]> {
  const { data, error } = await db
    .from("conhecimentos")
    .select("titulo, conteudo")
    .eq("setor", TRIAGEM_SETOR)
    .eq("ativo", true)
    .order("ordem", { ascending: true })
    .order("criado_em", { ascending: true })
    .limit(CONHECIMENTOS_CAP);
  if (error) {
    throw new Error(`falha ao ler conhecimentos: ${error.message}`);
  }
  return ((data ?? []) as ConhecimentoRow[]).map((row) => ({
    titulo: String(row.titulo ?? ""),
    conteudo: row.conteudo,
  }));
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
    .select("id, texto, veredito_rotulado, criado_em")
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
  janela: JanelaTriagem,
): Promise<AvisoRow[]> {
  // Campos minimos. effecti_id liga aos documentos via documento_vinculos. uf
  // nao e coluna -> extraido do payload_bruto via arrow (top-level, sem
  // trafegar o payload inteiro). data_captura ordena a FIFO.
  const selectCols = "id, effecti_id, objeto, orgao, data_publicacao, data_captura, " +
    "uf_direct:payload_bruto->>uf, uf_estado:payload_bruto->>estado, " +
    "uf_sigla:payload_bruto->>siglaUf";

  let query = db
    .from("avisos")
    .select(selectCols)
    .eq("status_indexacao", "indexado")
    .eq("reabilitado", false)
    .is("triagem_veredito", null);

  // Janela de datas configuravel (data_final). Cada .or() e combinado em AND.
  for (const filtro of janelaOrFilters(janela)) {
    query = query.or(filtro);
  }

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
// Documentos vinculados ao aviso + itens extraidos (recall por item).
// O servidor SO LE: entrega a lista de itens e o estado de extracao; a propria
// Lia extrai os 'pendente' e cruza com o catalogo. SEM embedding, SEM RPC de
// cruzamento, SEM produtos candidatos.
// ---------------------------------------------------------------------

async function loadDocumentosEItens(
  db: ServiceClient,
  avisos: AvisoRow[],
): Promise<{
  docsByAviso: Map<string, DocumentoFila[]>;
  itensByDocumento: Map<string, ItemLicitacao[]>;
}> {
  const docsByAviso = new Map<string, DocumentoFila[]>();
  const itensByDocumento = new Map<string, ItemLicitacao[]>();

  // effecti_id -> avisos (a MESMA licitacao pode aparecer em >1 aviso; o
  // vinculo e por effecti_id, dedup global de documento).
  const avisosByEffecti = new Map<string, AvisoRow[]>();
  for (const a of avisos) {
    const eid = (a.effecti_id ?? "").trim();
    if (eid === "") continue;
    const list = avisosByEffecti.get(eid) ?? [];
    list.push(a);
    avisosByEffecti.set(eid, list);
  }
  const effectiIds = [...avisosByEffecti.keys()];
  if (effectiIds.length === 0) {
    return { docsByAviso, itensByDocumento };
  }

  // 1) Vinculos effecti com texto aproveitavel -> documentos por effecti_id.
  //    Paginado: avisos compartilham editais -> muitos vinculos; sem .range()
  //    o teto de 1000 do PostgREST truncaria documentos em silencio (RECALL).
  const vinculos = await fetchAllRows<VinculoRow>("documento_vinculos", (from, to) =>
    db
      .from("documento_vinculos")
      .select("registro_origem_id, documento_id")
      .eq("fonte", "effecti")
      .in("registro_origem_id", effectiIds)
      .in("status_extracao", STATUS_EXTRACAO_COM_TEXTO)
      .range(from, to));

  // effecti_id -> Set(documento_id) (dedup: o mesmo doc pode ter N vinculos).
  const docIdsByEffecti = new Map<string, Set<string>>();
  const allDocIds = new Set<string>();
  for (const v of vinculos) {
    if (!v.registro_origem_id || !v.documento_id) continue;
    const set = docIdsByEffecti.get(v.registro_origem_id) ?? new Set<string>();
    set.add(v.documento_id);
    docIdsByEffecti.set(v.registro_origem_id, set);
    allDocIds.add(v.documento_id);
  }
  if (allDocIds.size === 0) {
    return { docsByAviso, itensByDocumento };
  }
  const docIdList = [...allDocIds];

  // 2) Metadados dos documentos (nome + itens_status) e itens, em lote.
  const [metaMap, itensMap] = await Promise.all([
    loadDocumentosMeta(db, docIdList),
    loadItensByDocumento(db, docIdList),
  ]);
  for (const [docId, itens] of itensMap) itensByDocumento.set(docId, itens);

  // 3) Distribui os documentos para cada aviso (via effecti_id compartilhado).
  for (const [eid, avisosDoEffecti] of avisosByEffecti) {
    const docIds = docIdsByEffecti.get(eid);
    if (!docIds || docIds.size === 0) continue;
    const documentos: DocumentoFila[] = [];
    for (const docId of docIds) {
      const meta = metaMap.get(docId);
      documentos.push({
        documento_id: docId,
        nome_arquivo: meta?.nome_arquivo ?? null,
        itens_status: meta?.itens_status ?? "pendente",
      });
    }
    for (const a of avisosDoEffecti) docsByAviso.set(a.id, documentos);
  }

  return { docsByAviso, itensByDocumento };
}

async function loadDocumentosMeta(
  db: ServiceClient,
  docIds: string[],
): Promise<Map<string, DocumentoMetaRow>> {
  const { data, error } = await db
    .from("documentos")
    .select("id, nome_arquivo, itens_status")
    .in("id", docIds);
  if (error) {
    throw new Error(`falha ao ler documentos: ${error.message}`);
  }
  const map = new Map<string, DocumentoMetaRow>();
  for (const row of (data ?? []) as DocumentoMetaRow[]) {
    map.set(row.id, row);
  }
  return map;
}

async function loadItensByDocumento(
  db: ServiceClient,
  docIds: string[],
): Promise<Map<string, ItemLicitacao[]>> {
  // Paginado: um edital pode ter centenas de itens em multiplas listas; sem
  // .range() o teto de 1000 do PostgREST truncaria itens em silencio (RECALL).
  // Ordena por (documento_id, lista_origem, ordem) p/ manter as listas que
  // convivem (corpo do edital + anexo TR) agrupadas e na ordem original.
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
  const map = new Map<string, ItemLicitacao[]>();
  for (const row of rows) {
    const list = map.get(row.documento_id) ?? [];
    list.push({
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
    });
    map.set(row.documento_id, list);
  }
  return map;
}

// ---------------------------------------------------------------------
// Few-shot: ativos, mais recentes primeiro, ate k. Sem embedding em runtime —
// a fila nao gera vetores (a Lia cruza/decide). Ranking por recencia.
// ---------------------------------------------------------------------

function selectFewShot(bank: ExemploRow[], k: number): FewShotExemplo[] {
  if (k <= 0 || bank.length === 0) return [];
  // O banco ja vem ordenado por recencia desc; toma os k mais recentes.
  return bank.slice(0, k).map((ex) => ({
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
