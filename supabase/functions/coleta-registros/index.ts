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
// A agregacao GROUP BY (fonte, registro_origem_id) roda no Postgres, na view
// vw_coleta_registros_mestra (apoiada no indice idx_documento_vinculos_fonte_registro):
// a Edge le SO a pagina via RPC coleta_registros_listar (keyset captado_em DESC,
// id_composto ASC) e o total por fonte via coleta_registros_contagens, e enriquece
// cabecalho/link apenas dos 25 itens da pagina. Toda leitura via service_role.
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
  CabecalhoNomusPessoa,
  ColetaRegistrosResponse,
  ContagensPorFonte,
  EfeitoColeta,
  ErroIngestao,
  Execucao,
  FonteColeta,
  RecursoCanonical,
  RegistroColetado,
  RegistroColetadoDetalhe,
  StatusExtracao,
  StatusIndexacaoAgregado,
  VinculoDetalhe,
} from "../_shared/registro-types.ts";
import { z } from "zod";

const FUNCTION_SEGMENT = "coleta-registros";

// Paginacao da lista (keyset) e tamanho do lote nas consultas `.in(...)`.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200; // teto do clamp [1, 200] (alinhado as RPCs da Sprint 2).
const IN_CHUNK = 300; // tamanho do lote em consultas `.in(...)` (limite de URL).

// Fontes e status agregados travados (enums do dominio).
const FONTES = ["effecti", "nomus", "drive", "gmail"] as const;
// status_indexacao_agregado: inclui 'sem_documentos' (registro sem anexo) da
// view re-ancorada (Sprint 1 da migration). Universo aceito no filtro ?status=.
const STATUS_AGREGADO = [
  "sem_documentos",
  "pendente",
  "em_andamento",
  "concluida",
  "erro",
  "mista",
] as const;

// Allowlist canonica FECHADA de (fonte, recurso). O id_composto carrega a
// tripla (fonte:recurso:registro_origem_id); o par precisa casar exatamente
// um ramo da view re-ancorada. Fora desta tabela -> 422 (SEC-03).
const RECURSO_POR_FONTE: Record<FonteColeta, readonly RecursoCanonical[]> = {
  effecti: ["avisos"],
  nomus: ["processos", "pessoas"],
  gmail: ["mensagens"],
  drive: ["arquivos"],
};

// ---------------------------------------------------------------------
// Tipos internos (linhas lidas do banco e agregado por registro).
// ---------------------------------------------------------------------

/** Linha da view vw_coleta_registros_mestra (1 por registro mestre). */
interface MestraRow {
  id_composto: string;
  fonte: string;
  recurso: string;
  registro_origem_id: string;
  captado_em: string;
  qtd_documentos: number;
  qtd_pendentes: number;
  qtd_erros: number;
  qtd_ignorado: number;
  status_indexacao_agregado: string;
  titulo_curto: string;
  rep_id: string;
  rep_nome_anexo: string | null;
  rep_documento_id: string | null;
  /** Efeito da execucao sobre o registro; presente SO no recorte por execucao. */
  efeito?: string | null;
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
  data_inicial: string | null;
  data_final: string | null;
  execucao_origem_id: string | null;
}

interface NomusLite {
  nomus_id: string;
  etapa: string | null;
  pessoa: string | null;
  tipo: string | null;
  data_criacao: string | null;
}

/** Subset de nomus_pessoas para o cabecalho discriminado nomus/pessoas. */
interface NomusPessoaLite {
  nomus_id: string;
  nome: string | null;
  nome_razao_social: string | null;
  cnpj: string | null;
  tipo_pessoa: string | null;
  codigo: string | null;
  municipio: string | null;
  uf: string | null;
}

/**
 * Linha mestra ja resolvida (vinda da view) consumida pelo montador de itens
 * da pagina. Espelha vw_coleta_registros_mestra em camelCase; o vinculo
 * representativo (rep*) alimenta o cabecalho Gmail/Drive.
 */
interface GroupAgg {
  fonte: FonteColeta;
  recurso: RecursoCanonical;
  origemId: string;
  idComposto: string;
  qtdDocumentos: number;
  qtdPendentes: number;
  qtdErros: number;
  qtdIgnorado: number;
  repId: string;
  repNomeAnexo: string | null;
  repDocumentoId: string | null;
  captadoEm: string;
  tituloCurto: string;
  statusAgregado: StatusIndexacaoAgregado;
  /** Efeito (novo|atualizado) no recorte por execucao; null na lista mestra. */
  efeito: EfeitoColeta | null;
}

interface CursorKeyset {
  /** captado_em (timestamptz ISO, precisao plena; chave do keyset, DESC). */
  c: string;
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
  /**
   * Recorte por execucao (clique numa execucao da guia Execucoes): id da
   * execucao. Quando presente, a lista vem do ledger execucao_registros (so os
   * registros TOCADOS por aquela rodada, rotulados novo|atualizado); null na
   * lista mestra cumulativa.
   */
  execucaoId: string | null;
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

/** Cursor opaco base64(JSON {c,k}); malformado -> 400. */
function parseCursor(raw: string | null): CursorKeyset | null {
  if (raw === null || raw.trim() === "") return null;
  try {
    const decoded = JSON.parse(atob(raw)) as unknown;
    if (
      decoded && typeof decoded === "object" &&
      typeof (decoded as CursorKeyset).c === "string" &&
      typeof (decoded as CursorKeyset).k === "string"
    ) {
      return { c: (decoded as CursorKeyset).c, k: (decoded as CursorKeyset).k };
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
    execucaoId: q.get("execucao_id")?.trim() || null,
  };
}

// ---------------------------------------------------------------------
// Helpers de leitura (service_role): scan paginado e busca por lote `.in`.
// ---------------------------------------------------------------------

type QueryResult = { data: unknown[] | null; error: { message: string } | null };

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

/** Booleano JSONB tolerante (bool nativo, "true"/"false", 1/0); ausente -> null. */
function jsonBool(obj: unknown, key: string): boolean | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "sim") return true;
    if (s === "false" || s === "0" || s === "nao" || s === "não") return false;
  }
  return null;
}

/** Mapeia 1 linha da view (snake_case) para o modelo da pagina (camelCase). */
function mestraRowToGroup(r: MestraRow): GroupAgg {
  return {
    fonte: r.fonte as FonteColeta,
    recurso: r.recurso as RecursoCanonical,
    origemId: r.registro_origem_id,
    idComposto: r.id_composto,
    qtdDocumentos: r.qtd_documentos,
    qtdPendentes: r.qtd_pendentes,
    qtdErros: r.qtd_erros,
    qtdIgnorado: r.qtd_ignorado,
    repId: r.rep_id,
    repNomeAnexo: r.rep_nome_anexo,
    repDocumentoId: r.rep_documento_id,
    captadoEm: r.captado_em,
    tituloCurto: r.titulo_curto,
    statusAgregado: r.status_indexacao_agregado as StatusIndexacaoAgregado,
    efeito: (r.efeito as EfeitoColeta | null | undefined) ?? null,
  };
}

/**
 * Monta ContagensPorFonte a partir das linhas da RPC de contagem
 * (coleta_registros_contagens -> colunas fonte/qtd). Nomus ja soma
 * processos + pessoas na propria RPC (group by fonte sobre a view).
 */
function buildContagens(rows: { fonte: string; qtd: number | string }[]): ContagensPorFonte {
  const c: ContagensPorFonte = { effecti: 0, nomus: 0, gmail: 0, drive: 0, total: 0 };
  for (const r of rows) {
    if (!FONTES.includes(r.fonte as FonteColeta)) continue;
    const n = Number(r.qtd) || 0;
    c[r.fonte as FonteColeta] = n;
    c.total += n;
  }
  return c;
}

// ---------------------------------------------------------------------
// Handler da lista.
// ---------------------------------------------------------------------

async function handleList(req: Request): Promise<Response> {
  const params = parseListParams(req);
  const service = createServiceClient();

  // 1) Pagina por keyset (RPC). Pede limit+1 p/ saber se ha proxima pagina.
  //    Recorte por execucao -> ledger (coleta_registros_por_execucao, INNER JOIN
  //    pela tripla, traz o efeito novo|atualizado); lista mestra cumulativa ->
  //    coleta_registros_listar (efeito sempre NULL). Mesmos filtros e keyset.
  const { data: pageData, error: pageErr } = params.execucaoId
    ? await service.rpc("coleta_registros_por_execucao", {
      p_execucao_id: params.execucaoId,
      p_fonte: params.fonte,
      p_status: params.status,
      p_busca: params.busca,
      p_cursor_captado_em: params.cursor?.c ?? null,
      p_cursor_id_composto: params.cursor?.k ?? null,
      p_limit: params.limit + 1,
    })
    : await service.rpc("coleta_registros_listar", {
      p_fonte: params.fonte,
      p_status: params.status,
      p_busca: params.busca,
      p_cursor_captado_em: params.cursor?.c ?? null,
      p_cursor_id_composto: params.cursor?.k ?? null,
      p_limit: params.limit + 1,
    });
  if (pageErr) {
    throw new HttpError(500, "coleta_registros_listar_failed", "falha ao listar registros");
  }
  const rows = (pageData ?? []) as MestraRow[];
  const hasMore = rows.length > params.limit;
  const rawGroups = (hasMore ? rows.slice(0, params.limit) : rows).map(mestraRowToGroup);

  // tem_erro (E5): a RPC da Sprint 2 NAO recebe mais este filtro; aplicamos como
  // intersecao AND silenciosa com o status, em cima das linhas ja paginadas
  // (qtd_erros > 0). O keyset (hasMore/nextCursor) caminha sobre a ordenacao
  // BRUTA (linhas antes do filtro), entao a paginacao varre todo o universo sem
  // pular registros; combinacoes contraditorias (ex.: status=sem_documentos +
  // tem_erro=true) caem para conjunto vazio sem erro.
  const pageGroups = params.temErro ? rawGroups.filter((g) => g.qtdErros > 0) : rawGroups;

  // 2) contagensPorFonte: total por fonte (cumulativo, sem filtros) via RPC
  //    (1 chamada por request — RNF-02). Nomus = processos + pessoas.
  const { data: contData, error: contErr } = await service.rpc("coleta_registros_contagens");
  if (contErr) {
    throw new HttpError(500, "coleta_registros_contagens_failed", "falha ao contar registros");
  }
  const contagensPorFonte = buildContagens(
    (contData ?? []) as { fonte: string; qtd: number | string }[],
  );

  // 3) Cross-ref (Effecti -> avisos; Nomus -> processos/pessoas por recurso)
  //    APENAS dos itens da pagina, para o cabecalho discriminado / aviso_id /
  //    execucao de origem.
  const effectiIds = pageGroups.filter((g) => g.fonte === "effecti").map((g) => g.origemId);
  const nomusProcessosIds = pageGroups
    .filter((g) => g.fonte === "nomus" && g.recurso === "processos")
    .map((g) => g.origemId);
  const nomusPessoasIds = pageGroups
    .filter((g) => g.fonte === "nomus" && g.recurso === "pessoas")
    .map((g) => g.origemId);

  const avisosByEffecti = new Map<string, AvisoLite>();
  if (effectiIds.length > 0) {
    const avisoRows = (await fetchByIn("avisos", effectiIds, (chunk) =>
      service
        .from("avisos")
        .select(
          "id, effecti_id, objeto, orgao, modalidade, portal, data_publicacao, data_captura, data_inicial, data_final, execucao_origem_id",
        )
        .in("effecti_id", chunk))) as AvisoLite[];
    for (const a of avisoRows) avisosByEffecti.set(a.effecti_id, a);
  }

  const nomusById = new Map<string, NomusLite>();
  if (nomusProcessosIds.length > 0) {
    const nomusRows = (await fetchByIn("nomus_processos", nomusProcessosIds, (chunk) =>
      service
        .from("nomus_processos")
        .select("nomus_id, etapa, pessoa, tipo, data_criacao")
        .in("nomus_id", chunk))) as NomusLite[];
    for (const n of nomusRows) nomusById.set(n.nomus_id, n);
  }

  const nomusPessoaById = new Map<string, NomusPessoaLite>();
  if (nomusPessoasIds.length > 0) {
    const pessoaRows = (await fetchByIn("nomus_pessoas", nomusPessoasIds, (chunk) =>
      service
        .from("nomus_pessoas")
        .select("nomus_id, nome, nome_razao_social, cnpj, tipo_pessoa, codigo, municipio, uf")
        .in("nomus_id", chunk))) as NomusPessoaLite[];
    for (const p of pessoaRows) nomusPessoaById.set(p.nomus_id, p);
  }

  // 4) Cabecalho discriminado + link_original APENAS para os itens da pagina.
  const itens = await buildPageItems(
    service,
    pageGroups,
    avisosByEffecti,
    nomusById,
    nomusPessoaById,
  );

  // 5) Cursor da proxima pagina: ancorado na ultima linha BRUTA da pagina
  //    (rawGroups), nao na filtrada por tem_erro — assim o keyset nao pula
  //    registros quando o filtro esvazia a pagina exibida.
  const last = rawGroups[rawGroups.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ c: last.captadoEm, k: last.idComposto })
    : null;

  const body: ColetaRegistrosResponse = { itens, nextCursor, contagensPorFonte };
  return jsonResponse(body, 200);
}

/** Monta os RegistroColetado finais (cabecalho + link) dos itens da pagina. */
async function buildPageItems(
  service: ReturnType<typeof createServiceClient>,
  pageGroups: GroupAgg[],
  avisosByEffecti: Map<string, AvisoLite>,
  nomusById: Map<string, NomusLite>,
  nomusPessoaById: Map<string, NomusPessoaLite>,
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
    buildRegistro(
      g,
      avisosByEffecti,
      nomusById,
      nomusPessoaById,
      payloadByEffecti,
      refById,
      extByDoc,
    )
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
  /** Recurso canonico (discrimina nomus/processos vs nomus/pessoas). */
  recurso: RecursoCanonical;
  origemId: string;
  /** Fallback de data_captura (Effecti) quando o aviso nao traz a coluna. */
  captadoEm: string;
  aviso: AvisoLite | null;
  /** avisos.payload_bruto (jsonb) para uf/uasg/edital. */
  payloadEffecti: unknown;
  nomus: NomusLite | null;
  /** nomus_pessoas resolvido (recurso='pessoas'); null nos demais. */
  nomusPessoa: NomusPessoaLite | null;
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
      // SRP: descricao textual quando houver, senao deriva do booleano `srp`.
      const srpBool = jsonBool(payload, "srp");
      const srp = jsonStr(payload, "srpDescricao") ??
        (srpBool === true ? "Sim" : srpBool === false ? "Não" : null);
      const cab: CabecalhoEffecti = {
        fonte: "effecti",
        objeto: (aviso?.objeto ?? "").trim(),
        orgao: aviso?.orgao ?? "",
        unidade_gestora: jsonStr(payload, "unidadeGestora"),
        modalidade: aviso?.modalidade ?? "",
        portal: aviso?.portal ?? null,
        uf: jsonStr(payload, "uf") ?? jsonStr(payload, "estado") ??
          jsonStr(payload, "siglaUf"),
        uasg: jsonStr(payload, "uasg"),
        edital: jsonStr(payload, "processo") ?? jsonStr(payload, "edital") ??
          jsonStr(payload, "numero_edital"),
        srp,
        valor_estimado: jsonStr(payload, "valorTotalEstimado"),
        data_inicial: aviso?.data_inicial ?? jsonStr(payload, "dataInicialProposta"),
        data_final: aviso?.data_final ?? jsonStr(payload, "dataFinalProposta"),
        data_publicacao: aviso?.data_publicacao ?? null,
        data_captura: aviso?.data_captura ?? input.captadoEm,
      };
      return cab;
    }
    case "nomus": {
      // fonte='nomus' e ambigua (processos vs pessoas compartilham nomus_id):
      // o recurso da tripla decide a variante do cabecalho.
      if (input.recurso === "pessoas") {
        const p = input.nomusPessoa;
        const cab: CabecalhoNomusPessoa = {
          fonte: "nomus",
          recurso: "pessoas",
          nome: p?.nome ?? p?.nome_razao_social ?? null,
          cnpj: p?.cnpj ?? null,
          tipoPessoa: p?.tipo_pessoa ?? null,
          municipio: p?.municipio ?? null,
          uf: p?.uf ?? null,
          categorias: null,
          codigo: p?.codigo ?? null,
          nomusId: input.origemId,
        };
        return cab;
      }
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
        assunto: jsonStr(ref, "assunto"),
        remetente: jsonStr(ref, "remetente"),
        destinatarios: jsonStr(ref, "destinatarios"),
        cc: jsonStr(ref, "cc"),
        data_email: jsonStr(ref, "data_email"),
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
  nomusPessoaById: Map<string, NomusPessoaLite>,
  payloadByEffecti: Map<string, unknown>,
  refById: Map<string, { ref_obtencao: unknown; documento_id: string | null }>,
  extByDoc: Map<string, string | null>,
): RegistroColetado {
  const aviso = g.fonte === "effecti" ? avisosByEffecti.get(g.origemId) ?? null : null;
  const nomus = g.fonte === "nomus" && g.recurso === "processos"
    ? nomusById.get(g.origemId) ?? null
    : null;
  const nomusPessoa = g.fonte === "nomus" && g.recurso === "pessoas"
    ? nomusPessoaById.get(g.origemId) ?? null
    : null;
  const ref = (g.fonte === "gmail" || g.fonte === "drive")
    ? refById.get(g.repId)?.ref_obtencao ?? null
    : null;
  const extDoc = g.fonte === "gmail" && g.repDocumentoId
    ? extByDoc.get(g.repDocumentoId) ?? null
    : null;

  const cabecalho = montarCabecalho({
    fonte: g.fonte,
    recurso: g.recurso,
    origemId: g.origemId,
    captadoEm: g.captadoEm,
    aviso,
    payloadEffecti: g.fonte === "effecti" ? payloadByEffecti.get(g.origemId) ?? null : null,
    nomus,
    nomusPessoa,
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
    efeito: g.efeito,
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
 * Parseia o :id_composto (ja URL-decoded) na TRIPLA
 * (fonte, recurso, registro_origem_id). O split e nos DOIS PRIMEIROS ':' —
 * o registro_origem_id pode conter ':' (preservado integralmente).
 *
 * fonte fora do allowlist FONTES -> 422; recurso vazio -> 400;
 * registro_origem_id vazio -> 400; par (fonte, recurso) fora da allowlist
 * canonica fechada (RECURSO_POR_FONTE) -> 422. O registro_origem_id e SEMPRE
 * binding parametrizado (.eq) a jusante, nunca concatenado em SQL.
 */
function parseIdComposto(
  idComposto: string,
): { fonte: FonteColeta; recurso: RecursoCanonical; origemId: string } {
  const first = idComposto.indexOf(":");
  if (first <= 0) {
    throw new HttpError(
      400,
      "id_composto_invalido",
      "id_composto invalido: use o formato fonte:recurso:registro_origem_id",
    );
  }
  const fonteRaw = idComposto.slice(0, first);

  // Whitelist do enum fonte (zod): fora do enum -> 422 (allowlist, SEC-03).
  const fonteParsed = idCompostoFonteSchema.safeParse(fonteRaw);
  if (!fonteParsed.success) {
    throw new HttpError(422, "fonte_invalida", `fonte invalida: use ${FONTES.join(", ")}`);
  }
  const fonte = fonteParsed.data;

  // Segundo ':' separa recurso de registro_origem_id (que pode conter ':').
  const second = idComposto.indexOf(":", first + 1);
  if (second < 0) {
    throw new HttpError(
      400,
      "recurso_invalido",
      "id_composto invalido: recurso ausente (use fonte:recurso:registro_origem_id)",
    );
  }
  const recursoRaw = idComposto.slice(first + 1, second);
  const origemId = idComposto.slice(second + 1);

  if (recursoRaw.trim() === "") {
    throw new HttpError(400, "recurso_invalido", "recurso ausente");
  }
  if (origemId.trim() === "") {
    throw new HttpError(400, "registro_origem_id_invalido", "registro_origem_id ausente");
  }

  // Par (fonte, recurso) precisa casar exatamente a allowlist canonica fechada.
  const recursosPermitidos = RECURSO_POR_FONTE[fonte];
  if (!recursosPermitidos.includes(recursoRaw as RecursoCanonical)) {
    throw new HttpError(
      422,
      "par_fonte_recurso_invalido",
      `par (fonte, recurso) invalido: ${fonte} aceita ${recursosPermitidos.join(", ")}`,
    );
  }
  return { fonte, recurso: recursoRaw as RecursoCanonical, origemId };
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
  const { fonte, recurso, origemId } = parseIdComposto(idComposto);
  const service = createServiceClient();

  // 1) Registro-fonte por (fonte, recurso). O 404 do detalhe e governado pela
  //    EXISTENCIA do registro na tabela-fonte (NAO pela presenca de anexo):
  //    Effecti -> avisos, nomus/processos -> nomus_processos, nomus/pessoas ->
  //    nomus_pessoas. Gmail/Drive nao tem tabela-fonte propria (existem so como
  //    conjunto de documento_vinculos): a existencia e checada via vinculos (2).
  let aviso: AvisoDetailRow | null = null;
  let nomus: NomusLite | null = null;
  let nomusPessoa: NomusPessoaLite | null = null;

  if (fonte === "effecti") {
    const { data, error } = await service
      .from("avisos")
      .select(
        "id, effecti_id, objeto, orgao, modalidade, portal, data_publicacao, data_captura, data_inicial, data_final, execucao_origem_id, payload_bruto",
      )
      .eq("effecti_id", origemId)
      .maybeSingle();
    if (error) {
      throw new HttpError(500, "avisos_query_failed", "falha ao consultar aviso do registro");
    }
    aviso = (data as AvisoDetailRow | null) ?? null;
    if (!aviso) {
      throw new HttpError(404, "registro_nao_encontrado", "registro nao encontrado");
    }
  } else if (fonte === "nomus" && recurso === "processos") {
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
    if (!nomus) {
      throw new HttpError(404, "registro_nao_encontrado", "registro nao encontrado");
    }
  } else if (fonte === "nomus" && recurso === "pessoas") {
    const { data, error } = await service
      .from("nomus_pessoas")
      .select("nomus_id, nome, nome_razao_social, cnpj, tipo_pessoa, codigo, municipio, uf")
      .eq("nomus_id", origemId)
      .maybeSingle();
    if (error) {
      throw new HttpError(
        500,
        "nomus_pessoas_query_failed",
        "falha ao consultar pessoa do registro",
      );
    }
    nomusPessoa = (data as NomusPessoaLite | null) ?? null;
    if (!nomusPessoa) {
      throw new HttpError(404, "registro_nao_encontrado", "registro nao encontrado");
    }
  }

  // 2) Vinculos do registro — binding parametrizado (.eq), sem concatenacao.
  //    Ordenado por created_at ASC (desempate id ASC): a 1a linha e o
  //    vinculo representativo usado no cabecalho (Gmail/Drive). Pode vir VAZIO
  //    para Effecti/Nomus (registro-fonte sem anexo) -> 200 com vinculos: [].
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

  // Gmail/Drive nao tem tabela-fonte: a existencia do registro e ter ao menos
  // um vinculo. Sem vinculos => registro inexistente => 404.
  if ((fonte === "gmail" || fonte === "drive") && vinculoRows.length === 0) {
    throw new HttpError(404, "registro_nao_encontrado", "registro nao encontrado");
  }

  // 3) Resolve documentos dos vinculos com documento_id (lote .in).
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

  // 4) Cabecalho discriminado (reusa montarCabecalho da lista). rep pode ser
  //    null quando o registro-fonte nao tem anexo (Effecti/Nomus): montarCabecalho
  //    e null-safe e nao depende de rep para effecti/nomus.
  const rep = vinculoRows[0] ?? null; // representativo: menor created_at (desempate id).
  const repExtensaoDoc = rep?.documento_id
    ? docsById.get(rep.documento_id)?.extensao ?? null
    : null;

  const cabecalho = montarCabecalho({
    fonte,
    recurso,
    origemId,
    captadoEm: aviso?.data_captura ?? rep?.created_at ?? "",
    aviso,
    payloadEffecti: aviso?.payload_bruto ?? null,
    nomus,
    nomusPessoa,
    repNomeAnexo: rep?.nome_anexo ?? null,
    repRef: rep?.ref_obtencao ?? null,
    repExtensaoDoc,
  });

  // 5) Link do registro (mesma regra da lista; ref do representativo p/ Gmail;
  //    null para nomus/pessoas — fonte nomus nunca tem link publico).
  const linkOriginal = linkOriginalRegistro(fonte, origemId, rep?.ref_obtencao ?? null);

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
