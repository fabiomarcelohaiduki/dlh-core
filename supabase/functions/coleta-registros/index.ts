// =====================================================================
// Edge Function: coleta-registros  ->  GET /coleta-registros
//
// LISTA MESTRA cumulativa da guia "Dados": 1 linha por
// (fonte, registro_origem_id) agregando os vinculos de documento_vinculos,
// ORDER BY captado_em DESC (tiebreaker id_composto ASC), paginada por
// keyset (cursor opaco base64). Cada linha traz:
//   - contagens agregadas do registro (qtd_documentos/pendentes/erros/ignorado);
//   - status_indexacao_agregado por precedencia deterministica (SPEC 4.5.4);
//   - cabecalho discriminado por fonte (provenance da SPEC 3.2.1, null-safe);
//   - link_original (helper _shared/link-original.ts) + tem_link_publico.
// Alem de `contagensPorFonte` CUMULATIVO (independente de paginacao/filtros).
//
// ZERO migration: tudo e READ via service_role. A agregacao GROUP BY
// (fonte, registro_origem_id) e materializada no Edge (apoiada no indice
// idx_documento_vinculos_fonte_registro), pois o `captado_em` do Effecti vem
// de avisos.data_captura (cross-join) e nao pode sair de uma unica query.
//
// Borda de seguranca (SPEC 5): handleCorsPreflight -> assertMethod(GET) ->
// requireAuthorizedUser (401/403) -> validacao zod dos params -> service_role
// para TODAS as consultas (sem createAnonClient). errorResponse padroniza erros.
//
// A rota de DETALHE (GET /coleta-registros/:id_composto) vive neste MESMO
// arquivo (ver parseRoute -> handleDetail), reaproveitando esta borda e o
// montador de cabecalho discriminado (montarCabecalho). Recebe :id_composto
// URL-encoded, parseia (fonte, registro_origem_id) com whitelist do enum
// fonte, e retorna RegistroColetadoDetalhe com cabecalho, vinculos[], erros[],
// execucao_origem (so Effecti via avisos.execucao_origem_id) e link_original.
// registro_origem_id e SEMPRE binding parametrizado (.eq), nunca concatenado.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { montarLinkOriginal } from "../_shared/link-original.ts";
import type {
  CabecalhoDiscriminado,
  CabecalhoDrive,
  CabecalhoEffecti,
  CabecalhoGmail,
  CabecalhoNomus,
  ColetaRegistrosResponse,
  ContagensPorFonte,
  ErroIngestao,
  Execucao,
  FonteColeta,
  RegistroColetado,
  RegistroColetadoDetalhe,
  StatusExtracao,
  StatusIndexacaoAgregado,
  VinculoDetalhe,
} from "../_shared/registro-types.ts";
import { z } from "zod";

const FUNCTION_SEGMENT = "coleta-registros";

// Paginacao da lista (keyset) e dos scans internos ao banco.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SCAN_PAGE = 1000; // teto de linhas por requisicao PostgREST.
const IN_CHUNK = 300; // tamanho do lote em consultas `.in(...)` (limite de URL).

// Fontes e status agregados travados (enums do dominio).
const FONTES = ["effecti", "nomus", "drive", "gmail"] as const;
const STATUS_AGREGADO = [
  "pendente",
  "em_andamento",
  "concluida",
  "erro",
  "mista",
] as const;

// Particionamento dos status_extracao do vinculo nas contagens/agregado.
const PENDENTE_SET = new Set(["pendente", "precisa_ocr"]);
const ERRO_SET = new Set(["erro", "inobtenivel"]);
const EXTRAIDO_SET = new Set(["extraido", "herdado"]);

// ---------------------------------------------------------------------
// Tipos internos (linhas lidas do banco e agregado por registro).
// ---------------------------------------------------------------------

interface VinculoScanRow {
  id: string;
  fonte: string;
  registro_origem_id: string;
  nome_anexo: string | null;
  status_extracao: string;
  documento_id: string | null;
  created_at: string;
}

interface AvisoLite {
  id: string;
  effecti_id: string;
  objeto: string | null;
  orgao: string | null;
  modalidade: string | null;
  portal: string | null;
  data_publicacao: string | null;
  data_captura: string | null;
  execucao_origem_id: string | null;
}

interface NomusLite {
  nomus_id: string;
  etapa: string | null;
  pessoa: string | null;
  tipo: string | null;
  data_criacao: string | null;
}

/** Agregado mutavel de 1 registro (linha mestra) durante o processamento. */
interface GroupAgg {
  fonte: FonteColeta;
  origemId: string;
  idComposto: string;
  qtdDocumentos: number;
  qtdPendentes: number;
  qtdErros: number;
  qtdIgnorado: number;
  hasPendente: boolean;
  hasExtraido: boolean;
  hasErro: boolean;
  // Vinculo representativo (menor created_at; desempate por id): origem do
  // cabecalho Gmail/Drive e do captado_em das fontes nao-Effecti.
  repId: string;
  repCreatedMs: number;
  repCreatedIso: string;
  repNomeAnexo: string | null;
  repDocumentoId: string | null;
  // Preenchidos na fase de enriquecimento (cross-ref + derivacao).
  captadoEm: string;
  captadoMs: number;
  tituloCurto: string;
  statusAgregado: StatusIndexacaoAgregado;
}

interface CursorKeyset {
  /** captado_em em epoch millis (chave primaria do keyset, DESC). */
  t: number;
  /** id_composto (tiebreaker estavel, ASC). */
  k: string;
}

// ---------------------------------------------------------------------
// Roteamento (lista vs. detalhe). Detalhe e escopo da sprint seguinte.
// ---------------------------------------------------------------------

type Route =
  | { kind: "list" }
  | { kind: "detail"; idComposto: string };

/**
 * Determina a rota a partir do path: base -> lista; qualquer segmento apos
 * `coleta-registros` -> detalhe (`:id_composto`, ainda nao implementado).
 */
function parseRoute(req: Request): Route {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const fnIdx = parts.indexOf(FUNCTION_SEGMENT);
  if (fnIdx >= 0 && parts.length > fnIdx + 1) {
    return { kind: "detail", idComposto: decodeURIComponent(parts[fnIdx + 1]) };
  }
  return { kind: "list" };
}

// ---------------------------------------------------------------------
// Validacao dos query params da lista.
// ---------------------------------------------------------------------

interface ListParams {
  limit: number;
  cursor: CursorKeyset | null;
  fonte: FonteColeta | null;
  status: StatusIndexacaoAgregado | null;
  /** Termo de busca ja trimado e lowercased; null quando < 2 chars/ausente. */
  busca: string | null;
  temErro: boolean;
}

/** limit: default 25, teto 100 (clampa); valor invalido -> 400. */
function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new HttpError(400, "invalid_limit", "limit deve ser um inteiro positivo");
  }
  return Math.min(n, MAX_LIMIT);
}

/** Cursor opaco base64(JSON {t,k}); malformado -> 400. */
function parseCursor(raw: string | null): CursorKeyset | null {
  if (raw === null || raw.trim() === "") return null;
  try {
    const decoded = JSON.parse(atob(raw)) as unknown;
    if (
      decoded && typeof decoded === "object" &&
      typeof (decoded as CursorKeyset).t === "number" &&
      typeof (decoded as CursorKeyset).k === "string"
    ) {
      return { t: (decoded as CursorKeyset).t, k: (decoded as CursorKeyset).k };
    }
    throw new Error("formato invalido");
  } catch {
    throw new HttpError(400, "invalid_cursor", "cursor invalido");
  }
}

function encodeCursor(keyset: CursorKeyset): string {
  return btoa(JSON.stringify(keyset));
}

// Schemas zod: fonte com status 422 (allowlist), demais filtros com 400.
const fonteSchema = z.enum(FONTES).optional();
// Whitelist do enum fonte usada no parse do :id_composto da rota de detalhe.
const idCompostoFonteSchema = z.enum(FONTES);
const filtersSchema = z.object({
  status: z.enum(STATUS_AGREGADO).optional(),
  tem_erro: z.enum(["true", "false", "1", "0"]).optional(),
  busca: z.string().optional(),
});

/** Valida e normaliza os query params da lista (zod + regras de borda). */
function parseListParams(req: Request): ListParams {
  const url = new URL(req.url);
  const q = url.searchParams;

  // fonte fora do enum -> 422 (allowlist), conforme SPEC 3.2.1 / SEC-03.
  const fonteParsed = fonteSchema.safeParse(q.get("fonte") ?? undefined);
  if (!fonteParsed.success) {
    throw new HttpError(422, "fonte_invalida", `fonte invalida: use ${FONTES.join(", ")}`);
  }

  // status/tem_erro/busca -> 400 quando fora do contrato.
  const filtersParsed = filtersSchema.safeParse({
    status: q.get("status") ?? undefined,
    tem_erro: q.get("tem_erro") ?? undefined,
    busca: q.get("busca") ?? undefined,
  });
  if (!filtersParsed.success) {
    const detail = filtersParsed.error.issues
      .map((i) => `${i.path.join(".") || "(param)"}: ${i.message}`)
      .join("; ");
    throw new HttpError(400, "validation_error", `parametros invalidos -> ${detail}`);
  }

  const buscaRaw = (filtersParsed.data.busca ?? "").trim();
  const temErroRaw = filtersParsed.data.tem_erro;

  return {
    limit: parseLimit(q.get("limit")),
    cursor: parseCursor(q.get("cursor")),
    fonte: fonteParsed.data ?? null,
    status: filtersParsed.data.status ?? null,
    busca: buscaRaw.length >= 2 ? buscaRaw.toLowerCase() : null,
    temErro: temErroRaw === "true" || temErroRaw === "1",
  };
}

// ---------------------------------------------------------------------
// Helpers de leitura (service_role): scan paginado e busca por lote `.in`.
// ---------------------------------------------------------------------

type QueryResult = { data: unknown[] | null; error: { message: string } | null };

/** Le TODAS as linhas de uma consulta paginando por `.range` (snapshot do request). */
async function scanAll(
  label: string,
  run: (from: number, to: number) => PromiseLike<QueryResult>,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await run(from, from + SCAN_PAGE - 1);
    if (error) {
      throw new HttpError(500, `${label}_query_failed`, `falha ao consultar ${label}`);
    }
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < SCAN_PAGE) break;
    from += SCAN_PAGE;
  }
  return out;
}

/** Resolve linhas por uma lista de ids, em lotes (evita estourar a URL). */
async function fetchByIn(
  label: string,
  ids: string[],
  run: (chunk: string[]) => PromiseLike<QueryResult>,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    if (chunk.length === 0) continue;
    const { data, error } = await run(chunk);
    if (error) {
      throw new HttpError(500, `${label}_query_failed`, `falha ao consultar ${label}`);
    }
    out.push(...(data ?? []));
  }
  return out;
}

// ---------------------------------------------------------------------
// Derivacoes puras.
// ---------------------------------------------------------------------

/** Extrai uma string de um JSONB (null-safe); numeros viram string. */
function jsonStr(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === "string") return v.trim() !== "" ? v : null;
  if (typeof v === "number") return String(v);
  return null;
}

/** status_indexacao_agregado por precedencia deterministica (SPEC 4.5.4). */
function deriveStatusAgregado(g: GroupAgg): StatusIndexacaoAgregado {
  if (g.hasPendente) return "em_andamento"; // 1) {pendente, precisa_ocr}
  if (g.hasExtraido && !g.hasErro) return "concluida"; // 2)
  if (g.hasErro && !g.hasExtraido) return "erro"; // 3)
  if (g.hasExtraido && g.hasErro) return "mista"; // 4)
  return "pendente"; // 5) so 'ignorado' ou sem vinculos resolvidos
}

/** Comparador da ordenacao fixa: captado_em DESC, id_composto ASC. */
function compareGroups(a: GroupAgg, b: GroupAgg): number {
  if (a.captadoMs !== b.captadoMs) return b.captadoMs - a.captadoMs;
  if (a.idComposto < b.idComposto) return -1;
  if (a.idComposto > b.idComposto) return 1;
  return 0;
}

/** true quando `g` vem ESTRITAMENTE depois do cursor na ordenacao fixa. */
function isAfterCursor(g: GroupAgg, cursor: CursorKeyset): boolean {
  if (g.captadoMs < cursor.t) return true;
  if (g.captadoMs > cursor.t) return false;
  return g.idComposto > cursor.k;
}

// ---------------------------------------------------------------------
// Agregacao da lista mestra.
// ---------------------------------------------------------------------

/** Le todos os vinculos e agrega por (fonte, registro_origem_id). */
function buildGroups(rows: VinculoScanRow[]): Map<string, GroupAgg> {
  const groups = new Map<string, GroupAgg>();

  for (const row of rows) {
    if (!FONTES.includes(row.fonte as FonteColeta)) continue; // guarda defensiva
    const fonte = row.fonte as FonteColeta;
    const idComposto = `${fonte}:${row.registro_origem_id}`;
    const createdMs = Date.parse(row.created_at);
    const safeMs = Number.isFinite(createdMs) ? createdMs : 0;

    let g = groups.get(idComposto);
    if (!g) {
      g = {
        fonte,
        origemId: row.registro_origem_id,
        idComposto,
        qtdDocumentos: 0,
        qtdPendentes: 0,
        qtdErros: 0,
        qtdIgnorado: 0,
        hasPendente: false,
        hasExtraido: false,
        hasErro: false,
        repId: row.id,
        repCreatedMs: safeMs,
        repCreatedIso: row.created_at,
        repNomeAnexo: row.nome_anexo,
        repDocumentoId: row.documento_id,
        captadoEm: row.created_at,
        captadoMs: safeMs,
        tituloCurto: row.registro_origem_id,
        statusAgregado: "pendente",
      };
      groups.set(idComposto, g);
    }

    // Contagens por particao de status.
    g.qtdDocumentos += 1;
    const s = row.status_extracao;
    if (PENDENTE_SET.has(s)) {
      g.qtdPendentes += 1;
      g.hasPendente = true;
    } else if (ERRO_SET.has(s)) {
      g.qtdErros += 1;
      g.hasErro = true;
    } else if (EXTRAIDO_SET.has(s)) {
      g.hasExtraido = true;
    } else if (s === "ignorado") {
      g.qtdIgnorado += 1;
    }

    // Representativo = menor created_at (desempate por id).
    if (safeMs < g.repCreatedMs || (safeMs === g.repCreatedMs && row.id < g.repId)) {
      g.repId = row.id;
      g.repCreatedMs = safeMs;
      g.repCreatedIso = row.created_at;
      g.repNomeAnexo = row.nome_anexo;
      g.repDocumentoId = row.documento_id;
    }
  }

  return groups;
}

/** Contagem CUMULATIVA por fonte (1 por registro), independente de filtros. */
function buildContagens(groups: Iterable<GroupAgg>): ContagensPorFonte {
  const c: ContagensPorFonte = { effecti: 0, nomus: 0, gmail: 0, drive: 0, total: 0 };
  for (const g of groups) {
    c[g.fonte] += 1;
    c.total += 1;
  }
  return c;
}

// ---------------------------------------------------------------------
// Handler da lista.
// ---------------------------------------------------------------------

async function handleList(req: Request): Promise<Response> {
  const params = parseListParams(req);
  const service = createServiceClient();

  // 1) Scan completo de documento_vinculos (snapshot do request).
  const vinculoRows = (await scanAll("documento_vinculos", (from, to) =>
    service
      .from("documento_vinculos")
      .select(
        "id, fonte, registro_origem_id, nome_anexo, status_extracao, documento_id, created_at",
      )
      .order("id", { ascending: true })
      .range(from, to))) as VinculoScanRow[];

  const groups = buildGroups(vinculoRows);

  // 2) contagensPorFonte e cumulativo: calculado ANTES de qualquer filtro.
  const contagensPorFonte = buildContagens(groups.values());

  // 3) Cross-ref leve (Effecti -> avisos; Nomus -> nomus_processos) para
  //    captado_em/titulo_curto/busca/aviso_id e cabecalho dos itens da pagina.
  const effectiIds = [...groups.values()]
    .filter((g) => g.fonte === "effecti")
    .map((g) => g.origemId);
  const nomusIds = [...groups.values()]
    .filter((g) => g.fonte === "nomus")
    .map((g) => g.origemId);

  const avisosByEffecti = new Map<string, AvisoLite>();
  if (effectiIds.length > 0) {
    const avisoRows = (await fetchByIn("avisos", effectiIds, (chunk) =>
      service
        .from("avisos")
        .select(
          "id, effecti_id, objeto, orgao, modalidade, portal, data_publicacao, data_captura, execucao_origem_id",
        )
        .in("effecti_id", chunk))) as AvisoLite[];
    for (const a of avisoRows) avisosByEffecti.set(a.effecti_id, a);
  }

  const nomusById = new Map<string, NomusLite>();
  if (nomusIds.length > 0) {
    const nomusRows = (await fetchByIn("nomus_processos", nomusIds, (chunk) =>
      service
        .from("nomus_processos")
        .select("nomus_id, etapa, pessoa, tipo, data_criacao")
        .in("nomus_id", chunk))) as NomusLite[];
    for (const n of nomusRows) nomusById.set(n.nomus_id, n);
  }

  // 4) Enriquecimento: captado_em, titulo_curto, status agregado, busca.
  for (const g of groups.values()) {
    g.statusAgregado = deriveStatusAgregado(g);

    if (g.fonte === "effecti") {
      const aviso = avisosByEffecti.get(g.origemId);
      g.captadoEm = aviso?.data_captura ?? g.repCreatedIso;
      g.tituloCurto = (aviso?.objeto ?? "").trim() || g.origemId;
    } else if (g.fonte === "nomus") {
      g.captadoEm = g.repCreatedIso;
      g.tituloCurto = g.origemId; // nomus_id
    } else {
      // gmail / drive: captado_em do vinculo; titulo = nome do anexo/arquivo.
      g.captadoEm = g.repCreatedIso;
      g.tituloCurto = (g.repNomeAnexo ?? "").trim() || g.origemId;
    }
    const ms = Date.parse(g.captadoEm);
    g.captadoMs = Number.isFinite(ms) ? ms : 0;
  }

  // 5) Filtros server-side (fonte, status agregado, tem_erro, busca).
  const filtered: GroupAgg[] = [];
  for (const g of groups.values()) {
    if (params.fonte && g.fonte !== params.fonte) continue;
    if (params.status && g.statusAgregado !== params.status) continue;
    if (params.temErro && g.qtdErros <= 0) continue;
    if (params.busca && !matchesBusca(g, params.busca, avisosByEffecti, nomusById)) continue;
    filtered.push(g);
  }

  // 6) Ordenacao fixa + paginacao keyset.
  filtered.sort(compareGroups);
  let startIdx = 0;
  if (params.cursor) {
    const found = filtered.findIndex((g) => isAfterCursor(g, params.cursor as CursorKeyset));
    startIdx = found < 0 ? filtered.length : found;
  }
  const pageGroups = filtered.slice(startIdx, startIdx + params.limit);
  const hasMore = startIdx + pageGroups.length < filtered.length;
  const last = pageGroups[pageGroups.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ t: last.captadoMs, k: last.idComposto })
    : null;

  // 7) Cabecalho discriminado + link_original APENAS para os itens da pagina.
  const itens = await buildPageItems(service, pageGroups, avisosByEffecti, nomusById);

  const body: ColetaRegistrosResponse = { itens, nextCursor, contagensPorFonte };
  return jsonResponse(body, 200);
}

/** Match de busca por fonte (case-insensitive, substring). */
function matchesBusca(
  g: GroupAgg,
  termo: string,
  avisosByEffecti: Map<string, AvisoLite>,
  nomusById: Map<string, NomusLite>,
): boolean {
  const has = (v: string | null | undefined) => !!v && v.toLowerCase().includes(termo);
  switch (g.fonte) {
    case "effecti": {
      const a = avisosByEffecti.get(g.origemId);
      return has(a?.objeto) || has(a?.orgao);
    }
    case "nomus": {
      const n = nomusById.get(g.origemId);
      return has(g.origemId) || has(n?.pessoa);
    }
    case "gmail":
    case "drive":
      return has(g.repNomeAnexo);
    default:
      return false;
  }
}

/** Monta os RegistroColetado finais (cabecalho + link) dos itens da pagina. */
async function buildPageItems(
  service: ReturnType<typeof createServiceClient>,
  pageGroups: GroupAgg[],
  avisosByEffecti: Map<string, AvisoLite>,
  nomusById: Map<string, NomusLite>,
): Promise<RegistroColetado[]> {
  // payload_bruto Effecti (uf/uasg/edital) so dos avisos da pagina.
  const pageEffectiIds = pageGroups.filter((g) => g.fonte === "effecti").map((g) => g.origemId);
  const payloadByEffecti = new Map<string, unknown>();
  if (pageEffectiIds.length > 0) {
    const rows = (await fetchByIn("avisos", pageEffectiIds, (chunk) =>
      service
        .from("avisos")
        .select("effecti_id, payload_bruto")
        .in("effecti_id", chunk))) as { effecti_id: string; payload_bruto: unknown }[];
    for (const r of rows) payloadByEffecti.set(r.effecti_id, r.payload_bruto);
  }

  // ref_obtencao do vinculo representativo (Gmail/Drive) da pagina.
  const pageRepIds = pageGroups
    .filter((g) => g.fonte === "gmail" || g.fonte === "drive")
    .map((g) => g.repId);
  const refById = new Map<string, { ref_obtencao: unknown; documento_id: string | null }>();
  if (pageRepIds.length > 0) {
    const rows = (await fetchByIn("documento_vinculos", pageRepIds, (chunk) =>
      service
        .from("documento_vinculos")
        .select("id, ref_obtencao, documento_id")
        .in("id", chunk))) as { id: string; ref_obtencao: unknown; documento_id: string | null }[];
    for (const r of rows) {
      refById.set(r.id, { ref_obtencao: r.ref_obtencao, documento_id: r.documento_id });
    }
  }

  // documentos.extensao (Gmail) via documento_id resolvido do representativo.
  const gmailDocIds = pageGroups
    .filter((g) => g.fonte === "gmail" && g.repDocumentoId)
    .map((g) => g.repDocumentoId as string);
  const extByDoc = new Map<string, string | null>();
  if (gmailDocIds.length > 0) {
    const rows = (await fetchByIn("documentos", gmailDocIds, (chunk) =>
      service
        .from("documentos")
        .select("id, extensao")
        .in("id", chunk))) as { id: string; extensao: string | null }[];
    for (const r of rows) extByDoc.set(r.id, r.extensao);
  }

  return pageGroups.map((g) =>
    buildRegistro(g, avisosByEffecti, nomusById, payloadByEffecti, refById, extByDoc)
  );
}

/**
 * Entrada do montador de cabecalho discriminado. Carrega APENAS primitivos ja
 * resolvidos (sem GroupAgg nem SupabaseClient) para ser compartilhado entre a
 * lista (buildRegistro) e o detalhe (handleDetail) sem duplicar a logica de
 * provenance por fonte (SPEC 3.2.1, null-safe).
 */
interface CabecalhoInput {
  fonte: FonteColeta;
  origemId: string;
  /** Fallback de data_captura (Effecti) quando o aviso nao traz a coluna. */
  captadoEm: string;
  aviso: AvisoLite | null;
  /** avisos.payload_bruto (jsonb) para uf/uasg/edital. */
  payloadEffecti: unknown;
  nomus: NomusLite | null;
  /** Vinculo representativo: nome do anexo/arquivo (Gmail/Drive). */
  repNomeAnexo: string | null;
  /** Vinculo representativo: ref_obtencao (jsonb) para tipo/thread_id/mimeType. */
  repRef: unknown;
  /** documentos.extensao do vinculo representativo (Gmail), quando resolvido. */
  repExtensaoDoc: string | null;
}

/**
 * Monta o CabecalhoDiscriminado por fonte a partir da provenance da SPEC 3.2.1.
 * Funcao pura (sem I/O); todos os campos derivados de JSONB sao null-safe.
 * Reaproveitada pela linha mestra (lista) e pela expansao (detalhe).
 */
function montarCabecalho(input: CabecalhoInput): CabecalhoDiscriminado {
  switch (input.fonte) {
    case "effecti": {
      const aviso = input.aviso;
      const payload = input.payloadEffecti;
      const cab: CabecalhoEffecti = {
        fonte: "effecti",
        objeto: (aviso?.objeto ?? "").trim(),
        orgao: aviso?.orgao ?? "",
        modalidade: aviso?.modalidade ?? "",
        portal: aviso?.portal ?? null,
        data_publicacao: aviso?.data_publicacao ?? null,
        data_captura: aviso?.data_captura ?? input.captadoEm,
        uf: jsonStr(payload, "uf"),
        uasg: jsonStr(payload, "uasg"),
        edital: jsonStr(payload, "edital") ?? jsonStr(payload, "numero_edital"),
      };
      return cab;
    }
    case "nomus": {
      const n = input.nomus;
      const cab: CabecalhoNomus = {
        fonte: "nomus",
        nomus_id: input.origemId,
        etapa: n?.etapa ?? null,
        pessoa: n?.pessoa ?? null,
        tipo: n?.tipo ?? null,
        data_criacao: n?.data_criacao ?? null,
      };
      return cab;
    }
    case "gmail": {
      const ref = input.repRef;
      const tipoRaw = jsonStr(ref, "tipo");
      const tipo: "corpo" | "anexo" = tipoRaw === "corpo"
        ? "corpo"
        : tipoRaw === "anexo"
        ? "anexo"
        : (input.repNomeAnexo ?? "").includes("(corpo)")
        ? "corpo"
        : "anexo";
      const cab: CabecalhoGmail = {
        fonte: "gmail",
        nome_anexo: input.repNomeAnexo ?? "",
        extensao: input.repExtensaoDoc ?? jsonStr(ref, "extensao"),
        tipo,
        thread_id: jsonStr(ref, "thread_id"),
      };
      return cab;
    }
    default: {
      // drive
      const ref = input.repRef;
      const cab: CabecalhoDrive = {
        fonte: "drive",
        nome_arquivo: input.repNomeAnexo ?? jsonStr(ref, "nome") ?? "",
        mime_type: jsonStr(ref, "mimeType"),
      };
      return cab;
    }
  }
}

/** Link publico do registro por fonte (mesma regra na lista e no detalhe). */
function linkOriginalRegistro(fonte: FonteColeta, origemId: string, ref: unknown): string | null {
  switch (fonte) {
    case "effecti":
      return montarLinkOriginal("effecti", { effecti_id: origemId });
    case "gmail":
      return montarLinkOriginal("gmail", {
        thread_id: jsonStr(ref, "thread_id"),
        message_id: origemId,
      });
    case "drive":
      return montarLinkOriginal("drive", { file_id: origemId });
    case "nomus":
    default:
      return null; // Nomus nunca tem link publico.
  }
}

/** Constroi 1 RegistroColetado (cabecalho discriminado + link). */
function buildRegistro(
  g: GroupAgg,
  avisosByEffecti: Map<string, AvisoLite>,
  nomusById: Map<string, NomusLite>,
  payloadByEffecti: Map<string, unknown>,
  refById: Map<string, { ref_obtencao: unknown; documento_id: string | null }>,
  extByDoc: Map<string, string | null>,
): RegistroColetado {
  const aviso = g.fonte === "effecti" ? avisosByEffecti.get(g.origemId) ?? null : null;
  const nomus = g.fonte === "nomus" ? nomusById.get(g.origemId) ?? null : null;
  const ref = (g.fonte === "gmail" || g.fonte === "drive")
    ? refById.get(g.repId)?.ref_obtencao ?? null
    : null;
  const extDoc = g.fonte === "gmail" && g.repDocumentoId
    ? extByDoc.get(g.repDocumentoId) ?? null
    : null;

  const cabecalho = montarCabecalho({
    fonte: g.fonte,
    origemId: g.origemId,
    captadoEm: g.captadoEm,
    aviso,
    payloadEffecti: g.fonte === "effecti" ? payloadByEffecti.get(g.origemId) ?? null : null,
    nomus,
    repNomeAnexo: g.repNomeAnexo,
    repRef: ref,
    repExtensaoDoc: extDoc,
  });

  const avisoId = g.fonte === "effecti" ? aviso?.id ?? null : null;
  const execucaoOrigemId = g.fonte === "effecti" ? aviso?.execucao_origem_id ?? null : null;
  const linkOriginal = linkOriginalRegistro(g.fonte, g.origemId, ref);

  return {
    id_composto: g.idComposto,
    fonte: g.fonte,
    origem_id: g.origemId,
    captado_em: g.captadoEm,
    titulo_curto: g.tituloCurto,
    qtd_documentos: g.qtdDocumentos,
    qtd_pendentes: g.qtdPendentes,
    qtd_erros: g.qtdErros,
    qtd_ignorado: g.qtdIgnorado,
    tem_link_publico: linkOriginal !== null,
    status_indexacao_agregado: g.statusAgregado,
    cabecalho,
    link_original: linkOriginal,
    execucao_origem_id: execucaoOrigemId,
    aviso_id: avisoId,
  };
}

// ---------------------------------------------------------------------
// Detalhe (GET /coleta-registros/:id_composto).
// ---------------------------------------------------------------------

/** Linha de documento_vinculos lida no detalhe (com ref_obtencao + updated_at). */
interface VinculoDetailRow {
  id: string;
  documento_id: string | null;
  nome_anexo: string | null;
  status_extracao: string;
  erro: string | null;
  tentativas_extracao: number | null;
  ref_obtencao: unknown;
  created_at: string;
  updated_at: string;
}

/** Subset de documentos consumido pela expansao (metadados do anexo resolvido). */
interface DocumentoLite {
  id: string;
  extensao: string | null;
  tamanho_bytes: number | null;
  usou_ocr: boolean | null;
  status_indexacao: string | null;
}

/** Linha de avisos lida no detalhe (cabecalho + payload + execucao de origem). */
interface AvisoDetailRow extends AvisoLite {
  payload_bruto: unknown;
}

/** Linha de erros_ingestao (timestamp em `quando`, mapeado p/ created_at). */
interface ErroRow {
  id: string;
  aviso_id: string | null;
  execucao_id: string | null;
  severidade: string;
  etapa: string;
  mensagem: string;
  status_reprocesso: string | null;
  quando: string;
}

/** Linha de execucoes (colunas do runner: inicio/fim -> iniciada_em/finalizada_em). */
interface ExecucaoRow {
  id: string;
  status: string | null;
  inicio: string | null;
  fim: string | null;
}

/**
 * Parseia o :id_composto (ja URL-decoded) em (fonte, registro_origem_id).
 * fonte fora do enum -> 422; id_composto malformado / origem vazia -> 400.
 */
function parseIdComposto(idComposto: string): { fonte: FonteColeta; origemId: string } {
  const sep = idComposto.indexOf(":");
  if (sep <= 0) {
    throw new HttpError(
      400,
      "id_composto_invalido",
      "id_composto invalido: use o formato fonte:registro_origem_id",
    );
  }
  const fonteRaw = idComposto.slice(0, sep);
  const origemId = idComposto.slice(sep + 1);

  // Whitelist do enum fonte (zod): fora do enum -> 422 (allowlist, SEC-03).
  const fonteParsed = idCompostoFonteSchema.safeParse(fonteRaw);
  if (!fonteParsed.success) {
    throw new HttpError(422, "fonte_invalida", `fonte invalida: use ${FONTES.join(", ")}`);
  }
  if (origemId.trim() === "") {
    throw new HttpError(400, "registro_origem_id_invalido", "registro_origem_id ausente");
  }
  return { fonte: fonteParsed.data, origemId };
}

/** Mapeia 1 linha de documento_vinculos (+ documento resolvido) p/ VinculoDetalhe. */
function montarVinculoDetalhe(
  v: VinculoDetailRow,
  fonte: FonteColeta,
  origemId: string,
  docsById: Map<string, DocumentoLite>,
): VinculoDetalhe {
  const doc = v.documento_id ? docsById.get(v.documento_id) ?? null : null;
  return {
    id: v.id,
    documento_id: v.documento_id,
    nome_anexo: v.nome_anexo ?? "",
    status_extracao: v.status_extracao as StatusExtracao,
    erro: v.erro,
    tentativas_extracao: v.tentativas_extracao ?? 0,
    // Link do anexo na origem (mesma regra do registro; ref do PROPRIO vinculo).
    link_original: linkOriginalRegistro(fonte, origemId, v.ref_obtencao),
    extensao: doc?.extensao ?? null,
    mime_type: jsonStr(v.ref_obtencao, "mimeType"),
    tamanho_bytes: doc?.tamanho_bytes ?? null,
    usou_ocr: doc?.usou_ocr ?? null,
    status_indexacao: doc?.status_indexacao ?? null,
    created_at: v.created_at,
    updated_at: v.updated_at,
  };
}

/**
 * GET /coleta-registros/:id_composto — detalhe expandido de 1 registro.
 * Reaproveita a borda (assertMethod/auth) e o montarCabecalho da lista. Toda
 * leitura via service_role; registro_origem_id SEMPRE binding parametrizado.
 */
async function handleDetail(idComposto: string): Promise<Response> {
  const { fonte, origemId } = parseIdComposto(idComposto);
  const service = createServiceClient();

  // 1) Vinculos do registro — binding parametrizado (.eq), sem concatenacao.
  //    Ordenado por created_at ASC (desempate id ASC): a 1a linha e o
  //    vinculo representativo usado no cabecalho (Gmail/Drive).
  const { data: vinculoData, error: vinculoErr } = await service
    .from("documento_vinculos")
    .select(
      "id, documento_id, nome_anexo, status_extracao, erro, tentativas_extracao, ref_obtencao, created_at, updated_at",
    )
    .eq("fonte", fonte)
    .eq("registro_origem_id", origemId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (vinculoErr) {
    throw new HttpError(
      500,
      "documento_vinculos_query_failed",
      "falha ao consultar vinculos do registro",
    );
  }
  const vinculoRows = (vinculoData ?? []) as VinculoDetailRow[];

  // Registro inexistente: a lista mestra so contem (fonte, registro) com ao
  // menos um vinculo; sem vinculos => 404 (mesmo universo da lista).
  if (vinculoRows.length === 0) {
    throw new HttpError(404, "registro_nao_encontrado", "registro nao encontrado");
  }

  // 2) Resolve documentos dos vinculos com documento_id (lote .in).
  const docIds = [
    ...new Set(
      vinculoRows.map((v) => v.documento_id).filter((id): id is string => typeof id === "string"),
    ),
  ];
  const docsById = new Map<string, DocumentoLite>();
  if (docIds.length > 0) {
    const docRows = (await fetchByIn("documentos", docIds, (chunk) =>
      service
        .from("documentos")
        .select("id, extensao, tamanho_bytes, usou_ocr, status_indexacao")
        .in("id", chunk))) as DocumentoLite[];
    for (const d of docRows) docsById.set(d.id, d);
  }

  // 3) Cross-ref do cabecalho por fonte (Effecti -> avisos; Nomus -> processos).
  let aviso: AvisoDetailRow | null = null;
  let nomus: NomusLite | null = null;

  if (fonte === "effecti") {
    const { data, error } = await service
      .from("avisos")
      .select(
        "id, effecti_id, objeto, orgao, modalidade, portal, data_publicacao, data_captura, execucao_origem_id, payload_bruto",
      )
      .eq("effecti_id", origemId)
      .maybeSingle();
    if (error) {
      throw new HttpError(500, "avisos_query_failed", "falha ao consultar aviso do registro");
    }
    aviso = (data as AvisoDetailRow | null) ?? null;
  } else if (fonte === "nomus") {
    const { data, error } = await service
      .from("nomus_processos")
      .select("nomus_id, etapa, pessoa, tipo, data_criacao")
      .eq("nomus_id", origemId)
      .maybeSingle();
    if (error) {
      throw new HttpError(
        500,
        "nomus_processos_query_failed",
        "falha ao consultar processo do registro",
      );
    }
    nomus = (data as NomusLite | null) ?? null;
  }

  // 4) Cabecalho discriminado (reusa montarCabecalho da lista).
  const rep = vinculoRows[0]; // representativo: menor created_at (desempate id).
  const repExtensaoDoc = rep.documento_id
    ? docsById.get(rep.documento_id)?.extensao ?? null
    : null;

  const cabecalho = montarCabecalho({
    fonte,
    origemId,
    captadoEm: aviso?.data_captura ?? rep.created_at,
    aviso,
    payloadEffecti: aviso?.payload_bruto ?? null,
    nomus,
    repNomeAnexo: rep.nome_anexo,
    repRef: rep.ref_obtencao,
    repExtensaoDoc,
  });

  // 5) Link do registro (mesma regra da lista; ref do representativo p/ Gmail).
  const linkOriginal = linkOriginalRegistro(fonte, origemId, rep.ref_obtencao);

  // 6) Vinculos detalhados (por anexo).
  const vinculos = vinculoRows.map((v) => montarVinculoDetalhe(v, fonte, origemId, docsById));

  // 7) erros[] e execucao_origem: APENAS Effecti (via avisos.id / execucao_origem_id).
  let erros: ErroIngestao[] = [];
  let execucaoOrigem: Execucao | null = null;

  if (fonte === "effecti" && aviso) {
    const { data: erroData, error: erroErr } = await service
      .from("erros_ingestao")
      .select("id, aviso_id, execucao_id, severidade, etapa, mensagem, status_reprocesso, quando")
      .eq("aviso_id", aviso.id)
      .order("quando", { ascending: false });
    if (erroErr) {
      throw new HttpError(500, "erros_query_failed", "falha ao consultar erros do registro");
    }
    erros = ((erroData ?? []) as ErroRow[]).map((e) => ({
      id: e.id,
      aviso_id: e.aviso_id,
      execucao_id: e.execucao_id,
      severidade: e.severidade,
      etapa: e.etapa,
      mensagem: e.mensagem,
      status_reprocesso: e.status_reprocesso,
      created_at: e.quando, // erros_ingestao usa `quando` como timestamp.
    }));

    if (aviso.execucao_origem_id) {
      const { data: execData, error: execErr } = await service
        .from("execucoes")
        .select("id, status, inicio, fim")
        .eq("id", aviso.execucao_origem_id)
        .maybeSingle();
      if (execErr) {
        throw new HttpError(500, "execucoes_query_failed", "falha ao consultar execucao de origem");
      }
      const execRow = (execData as ExecucaoRow | null) ?? null;
      if (execRow) {
        // Mapeamento de colunas do runner sem ALTER TABLE: inicio/fim ->
        // iniciada_em/finalizada_em; fonte e 'effecti' (ramo Effecti-only).
        execucaoOrigem = {
          id: execRow.id,
          status: execRow.status ?? null,
          fonte: "effecti",
          iniciada_em: execRow.inicio ?? null,
          finalizada_em: execRow.fim ?? null,
        };
      }
    }
  }

  const body: RegistroColetadoDetalhe = {
    cabecalho,
    vinculos,
    erros,
    execucao_origem: execucaoOrigem,
    link_original: linkOriginal,
  };
  return jsonResponse(body, 200);
}

// ---------------------------------------------------------------------
// Entrada: borda de seguranca compartilhada (lista e detalhe).
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    // 1) Metodo antes de qualquer leitura. 2) Autorizacao antes do parse.
    assertMethod(req, ["GET"]);
    await requireAuthorizedUser(req);

    const route = parseRoute(req);
    if (route.kind === "detail") {
      // Detalhe (:id_composto) reaproveita ESTA borda (assertMethod -> auth)
      // ja aplicada acima; valida o param e le tudo via service_role.
      return await handleDetail(route.idComposto);
    }

    return await handleList(req);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
