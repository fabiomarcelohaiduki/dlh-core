// =====================================================================
// Edge Function: relacionamentos-panorama  (Relacionamentos V2 - dois grafos)
//
// GET /functions/v1/relacionamentos-panorama?tipo=&no_id=&profundidade=
//
// Retorna a "fotografia" capada de UM dos dois grafos de Relacionamentos
// (hierarquico OU semantico) para o cockpit. A UI consome este endpoint
// para renderizar a visao geral (mapa de nos/arestas) de um tipo por vez.
//
// Query params:
//   * tipo         (hierarquico|semantico) - OPCIONAL. Default lido de
//                  config_relacionamentos.tipo_default_panorama (fallback
//                  'hierarquico'). 400 se informado com valor invalido.
//   * no_id        (uuid) - OPCIONAL. Quando presente, ancora o panorama
//                  nesse no e devolve apenas a vizinhanca ate `profundidade`
//                  (via RPC relacoes_vizinhanca). Sem no_id, devolve o
//                  grafo GLOBAL daquele tipo. 400 se nao for uuid.
//   * profundidade (int) - OPCIONAL. Default 2, teto duro 5 (clamp
//                  server-side em [0, 5]). 400 se nao for inteiro.
//
// Comportamento (V2):
//   * Filtra public.relacoes.tipo_relacionamento = tipo.
//   * NAO filtra mais por status legado (RF-33): na V2 toda aresta nasce
//     visivel e a revisao humana marca incorreta=true para suprimir.
//   * OCULTA arestas incorreta=true.
//   * Aplica o cap com precedencia cap_por_grafo ?? 200.
//     Quando o universo de nos excede o cap, retorna truncado=true e inclui
//     apenas os primeiros `cap` nos e as arestas internas a esse conjunto.
//   * Resolve label/icone/cor por tipo de no usando config_tipos_no da org
//     + descritor (nome real da entidade) por tipo.
//   * NAO grava audit_log (rota de leitura - invariante PRD B.0/B.5/SEC-3).
//
// Resposta JSON (PanoramaResponse):
//   { nos: NoVisual[], arestas: ArestaVisual[], cap: int, truncado: boolean,
//     tipo: 'hierarquico'|'semantico', gerado_em: ISO8601 }
//
// Borda padrao:
//   handleCorsPreflight -> assertMethod GET (405) -> requireAuthorizedUser
//   (401/403) -> resolucao de org_id -> validacao de params (400) ->
//   leitura (config + relacoes/RPC + tipos) -> formatacao -> jsonResponse.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";
import {
  RELACIONAMENTOS_TIPOS_GRAFO,
  type RelacionamentoTipoGrafo,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-panorama";

/** Default interno aplicado SOMENTE quando cap_por_grafo e NULL. */
const DEFAULT_CAP = 200;

/** Profundidade default do panorama ancorado. */
const DEFAULT_PROFUNDIDADE = 2;

/** Teto duro de profundidade (clamp server-side em [0, MAX_PROFUNDIDADE]). */
const MAX_PROFUNDIDADE = 5;

/** UUID v1-v5 (case-insensitive). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------

/** Linha minima de relacoes que o handler consulta. */
interface RelacaoRow {
  origem_tipo: string;
  origem_id: string;
  destino_tipo: string;
  destino_id: string;
  relacao: string;
  metodo: "deterministico" | "sugerido";
  chave: string;
  confianca: number;
}

/** Linha de config_tipos_no (subset usado pela UI). */
interface TipoNoRow {
  tipo: string;
  label: string;
  icone: string;
  cor: string;
  ativo: boolean;
}

/** No visual serializado para a UI. */
interface NoVisual {
  tipo: string;
  id: string;
  label: string;
  icone: string;
  cor: string;
}

/** Aresta visual serializada para a UI. */
interface ArestaVisual {
  origem_tipo: string;
  origem_id: string;
  destino_tipo: string;
  destino_id: string;
  relacao: string;
  metodo: "deterministico" | "sugerido";
  confianca: number;
}

/** Linha retornada pela RPC relacoes_vizinhanca. */
interface VizinhoRpcRow {
  tipo: string;
  id: string;
  profundidade: number;
  caminho: string[];
}

/** Linha minima de config_relacionamentos (dois grafos). */
interface ConfigRow {
  cap_por_grafo: number | null;
  tipo_default_panorama: RelacionamentoTipoGrafo | null;
}

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Colunas de public.relacoes que o handler consulta. */
const REL_COLS =
  "origem_tipo, origem_id, destino_tipo, destino_id, relacao, metodo, chave, confianca";

/** Referencia minima de no (tipo + id). */
interface NoRef {
  tipo: string;
  id: string;
}

// ---------------------------------------------------------------------
// Parsing/validacao dos query params.
// ---------------------------------------------------------------------
interface PanoramaParams {
  tipoInformado: RelacionamentoTipoGrafo | null;
  noId: string | null;
  profundidade: number;
}

function parsePanoramaParams(url: URL): PanoramaParams {
  const params = url.searchParams;

  // tipo: OPCIONAL. Se informado, precisa ser um dos valores do enum.
  let tipoInformado: RelacionamentoTipoGrafo | null = null;
  const tipoRaw = params.get("tipo");
  if (tipoRaw !== null && tipoRaw !== "") {
    if (!(RELACIONAMENTOS_TIPOS_GRAFO as readonly string[]).includes(tipoRaw)) {
      throw new HttpError(
        400,
        "tipo_invalido",
        "parametro tipo invalido (use: hierarquico, semantico)",
      );
    }
    tipoInformado = tipoRaw as RelacionamentoTipoGrafo;
  }

  // no_id: OPCIONAL. Quando presente, precisa ser um uuid valido.
  let noId: string | null = null;
  const noIdRaw = params.get("no_id");
  if (noIdRaw !== null && noIdRaw !== "") {
    if (!UUID_RE.test(noIdRaw)) {
      throw new HttpError(400, "no_id_invalido", "parametro no_id deve ser um uuid");
    }
    noId = noIdRaw;
  }

  // profundidade: OPCIONAL. Inteiro; clamp server-side em [0, MAX_PROFUNDIDADE].
  let profundidade = DEFAULT_PROFUNDIDADE;
  const profRaw = params.get("profundidade");
  if (profRaw !== null && profRaw !== "") {
    const n = Number(profRaw);
    if (!Number.isInteger(n)) {
      throw new HttpError(400, "profundidade_invalida", "parametro profundidade deve ser inteiro");
    }
    profundidade = Math.max(0, Math.min(MAX_PROFUNDIDADE, n));
  }

  return { tipoInformado, noId, profundidade };
}

// ---------------------------------------------------------------------
// Resolucao de descritores (label rico por tipo de no).
// ---------------------------------------------------------------------

/** Tamanho maximo (chars) do label retornado para a UI. */
const LABEL_MAX_CHARS = 80;

interface TabelaDescritor {
  campo: string;
  prefixo?: string;
  tambem?: { campo: string; separador: string; prefixo?: string };
}

const TABELAS_DESCRITOR: Record<string, TabelaDescritor> = {
  documento: { campo: "nome_arquivo" },
  aviso: { campo: "objeto", prefixo: "", tambem: { campo: "orgao", separador: " · ", prefixo: "" } },
  processo: { campo: "nome" },
  pessoa: { campo: "nome" },
  produto: { campo: "nome" },
  linha: { campo: "nome" },
  sku: { campo: "codigo_sku" },
};

function truncarLabel(texto: string | null | undefined, max: number = LABEL_MAX_CHARS): string | null {
  if (!texto) return null;
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (!limpo) return null;
  if (limpo.length <= max) return limpo;
  return `${limpo.slice(0, max - 1).trimEnd()}…`;
}

async function resolverDescritores(
  db: ServiceClient,
  nos: ReadonlyArray<NoRef>,
): Promise<Map<string, string>> {
  const idsPorTipo = new Map<string, string[]>();
  for (const n of nos) {
    if (!TABELAS_DESCRITOR[n.tipo]) continue;
    const arr = idsPorTipo.get(n.tipo) ?? [];
    arr.push(n.id);
    idsPorTipo.set(n.tipo, arr);
  }
  if (idsPorTipo.size === 0) return new Map();

  const promises = Array.from(idsPorTipo.entries()).map(async ([tipo, ids]) => {
    const cfg = TABELAS_DESCRITOR[tipo];
    const colunas = cfg.tambem ? `${cfg.campo}, ${cfg.tambem.campo}` : cfg.campo;
    const { data, error } = await db
      .from(tabelaDoTipo(tipo))
      .select(`id, ${colunas}`)
      .in("id", ids);
    if (error) {
      console.warn(`[relacionamentos-panorama] descritor ${tipo} falhou:`, error.message);
      return new Map<string, string>();
    }
    const local = new Map<string, string>();
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const id = String(row.id);
      const principal = truncarLabel(String(row[cfg.campo] ?? "") || null);
      if (!principal) continue;
      let label = `${cfg.prefixo ?? ""}${principal}`;
      if (cfg.tambem) {
        const aux = truncarLabel(String(row[cfg.tambem.campo] ?? "") || null, LABEL_MAX_CHARS / 2);
        if (aux) {
          label = `${cfg.tambem.prefixo ?? ""}${aux}${cfg.tambem.separador}${label}`;
        }
      }
      local.set(`${tipo}:${id}`, label);
    }
    return local;
  });

  const results = await Promise.all(promises);
  const merged = new Map<string, string>();
  for (const m of results) {
    for (const [k, v] of m.entries()) merged.set(k, v);
  }
  return merged;
}

/** Resolve o nome da tabela-fonte de descritor para um dado tipo. */
function tabelaDoTipo(tipo: string): string {
  switch (tipo) {
    case "documento":
      return "documentos";
    case "aviso":
      return "avisos";
    case "processo":
      return "nomus_processos";
    case "pessoa":
      return "nomus_pessoas";
    case "produto":
      return "produtos";
    case "linha":
      return "produto_linhas";
    case "sku":
      return "produto_skus";
    default:
      return tipo;
  }
}

// ---------------------------------------------------------------------
// Resolucao visual do tipo (label/icone/cor).
// ---------------------------------------------------------------------
async function resolverTipos(
  db: ServiceClient,
  orgId: string,
): Promise<Map<string, TipoNoRow>> {
  const { data, error } = await db
    .from("config_tipos_no")
    .select("tipo, label, icone, cor, ativo")
    .eq("org_id", orgId);
  if (error) {
    throw new HttpError(500, "tipos_query_failed", "falha ao consultar tipos de no da org");
  }
  const mapa = new Map<string, TipoNoRow>();
  for (const row of (data ?? []) as TipoNoRow[]) {
    mapa.set(row.tipo, row);
  }
  return mapa;
}

// ---------------------------------------------------------------------
// Coleta de arestas.
// ---------------------------------------------------------------------

/** Grafo GLOBAL: todas as arestas do tipo (nao incorretas). */
async function coletarArestasGlobais(
  db: ServiceClient,
  tipo: RelacionamentoTipoGrafo,
): Promise<RelacaoRow[]> {
  const { data, error } = await db
    .from("relacoes")
    .select(REL_COLS)
    .eq("tipo_relacionamento", tipo)
    .eq("incorreta", false);
  if (error) {
    throw new HttpError(500, "relacoes_query_failed", "falha ao listar arestas do grafo");
  }
  return (data ?? []) as RelacaoRow[];
}

/**
 * Descobre o tipo de no da ancora `no_id` a partir de UMA aresta do grafo
 * pedido que a referencie (origem OU destino). A RPC de vizinhanca exige o
 * par (tipo, id); como no_id chega sem tipo, inferimos aqui. Retorna null
 * quando a ancora nao participa de nenhuma aresta desse tipo.
 */
async function descobrirTipoAncora(
  db: ServiceClient,
  tipo: RelacionamentoTipoGrafo,
  noId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("relacoes")
    .select("origem_tipo, origem_id, destino_tipo, destino_id")
    .eq("tipo_relacionamento", tipo)
    .eq("incorreta", false)
    .or(`origem_id.eq.${noId},destino_id.eq.${noId}`)
    .limit(1);
  if (error) {
    throw new HttpError(500, "relacoes_query_failed", "falha ao localizar a ancora do panorama");
  }
  const row = (data ?? [])[0] as
    | { origem_tipo: string; origem_id: string; destino_tipo: string; destino_id: string }
    | undefined;
  if (!row) return null;
  return row.origem_id === noId ? row.origem_tipo : row.destino_tipo;
}

/**
 * Vizinhanca ANCORADA via RPC relacoes_vizinhanca (SECURITY DEFINER),
 * filtrada por tipo_relacionamento. Retorna os nos da vizinhanca (inclui a
 * ancora com profundidade 0), ja ordenados por profundidade asc no plano SQL.
 */
async function coletarNosVizinhanca(
  db: ServiceClient,
  ancoraTipo: string,
  noId: string,
  profundidade: number,
  tipo: RelacionamentoTipoGrafo,
): Promise<NoRef[]> {
  const { data, error } = await db.rpc("relacoes_vizinhanca", {
    p_tipo: ancoraTipo,
    p_id: noId,
    p_profundidade: profundidade,
    p_tipo_relacionamento: tipo,
  });
  if (error) {
    throw new HttpError(500, "vizinhanca_query_failed", "falha ao consultar a vizinhanca da ancora");
  }
  return ((data ?? []) as VizinhoRpcRow[]).map((row) => ({ tipo: row.tipo, id: row.id }));
}

/**
 * Arestas INTERNAS a um conjunto de nos (ambas as pontas visiveis), do
 * tipo pedido e nao incorretas. Como toda aresta interna tem sua origem no
 * conjunto, filtramos por origem_id IN ids e conferimos as duas pontas.
 */
async function coletarArestasEntreNos(
  db: ServiceClient,
  tipo: RelacionamentoTipoGrafo,
  nos: ReadonlyArray<NoRef>,
): Promise<RelacaoRow[]> {
  if (nos.length === 0) return [];
  const ids = [...new Set(nos.map((n) => n.id))];
  const { data, error } = await db
    .from("relacoes")
    .select(REL_COLS)
    .eq("tipo_relacionamento", tipo)
    .eq("incorreta", false)
    .in("origem_id", ids);
  if (error) {
    throw new HttpError(500, "relacoes_query_failed", "falha ao listar arestas da vizinhanca");
  }
  const chavesVisiveis = new Set(nos.map((n) => `${n.tipo}:${n.id}`));
  return ((data ?? []) as RelacaoRow[]).filter((a) =>
    chavesVisiveis.has(`${a.origem_tipo}:${a.origem_id}`) &&
    chavesVisiveis.has(`${a.destino_tipo}:${a.destino_id}`)
  );
}

// ---------------------------------------------------------------------
// Formatacao de nos/arestas para a UI.
// ---------------------------------------------------------------------
async function formatarNos(
  db: ServiceClient,
  orgId: string,
  nosVisiveis: ReadonlyArray<NoRef>,
): Promise<NoVisual[]> {
  const [tiposMap, descritores] = await Promise.all([
    resolverTipos(db, orgId),
    resolverDescritores(db, nosVisiveis),
  ]);

  return nosVisiveis.map((n) => {
    const t = tiposMap.get(n.tipo);
    const descritor = descritores.get(`${n.tipo}:${n.id}`);
    if (t && t.ativo) {
      return {
        tipo: n.tipo,
        id: n.id,
        label: descritor ?? t.label,
        icone: t.icone,
        cor: t.cor,
      };
    }
    return {
      tipo: n.tipo,
      id: n.id,
      label: descritor ?? n.tipo,
      icone: "circle",
      cor: "#a1a1aa",
    };
  });
}

function formatarArestas(arestas: ReadonlyArray<RelacaoRow>): ArestaVisual[] {
  return arestas.map((a) => ({
    origem_tipo: a.origem_tipo,
    origem_id: a.origem_id,
    destino_tipo: a.destino_tipo,
    destino_id: a.destino_id,
    relacao: a.relacao,
    metodo: a.metodo,
    confianca: Number(a.confianca),
  }));
}

// ---------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");
    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();
    const orgId = await resolverOrgIdUsuario(db, ctx.user.id);

    const params = parsePanoramaParams(new URL(req.url));

    // 1) Config da org: cap (precedencia) + tipo default do panorama.
    const { data: cfgRow, error: cfgError } = await db
      .from("config_relacionamentos")
      .select("cap_por_grafo, tipo_default_panorama")
      .eq("org_id", orgId)
      .maybeSingle();
    if (cfgError) {
      throw new HttpError(500, "config_query_failed", "falha ao consultar configuracao da org");
    }
    const cfg = (cfgRow ?? null) as ConfigRow | null;

    const cap = cfg?.cap_por_grafo ?? DEFAULT_CAP;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new HttpError(500, "config_cap_invalido", "cap do panorama da org e invalido");
    }

    const tipo: RelacionamentoTipoGrafo = params.tipoInformado ??
      cfg?.tipo_default_panorama ?? "hierarquico";

    // 2) Universo de nos + arestas conforme o modo (global vs ancorado).
    let todosOsNos: NoRef[];
    let arestasBrutas: RelacaoRow[];

    if (params.noId) {
      // Modo ANCORADO: expande a vizinhanca do no via RPC (filtrada por tipo).
      const ancoraTipo = await descobrirTipoAncora(db, tipo, params.noId);
      if (!ancoraTipo) {
        // Ancora sem nenhuma aresta desse tipo: subgrafo vazio (nao truncado).
        return jsonResponse(
          {
            nos: [],
            arestas: [],
            cap,
            truncado: false,
            tipo,
            gerado_em: new Date().toISOString(),
          },
          200,
        );
      }
      todosOsNos = await coletarNosVizinhanca(
        db,
        ancoraTipo,
        params.noId,
        params.profundidade,
        tipo,
      );
    } else {
      // Modo GLOBAL: todas as arestas do tipo (nao incorretas).
      arestasBrutas = await coletarArestasGlobais(db, tipo);
      const nosMap = new Map<string, NoRef>();
      for (const a of arestasBrutas) {
        nosMap.set(`${a.origem_tipo}:${a.origem_id}`, { tipo: a.origem_tipo, id: a.origem_id });
        nosMap.set(`${a.destino_tipo}:${a.destino_id}`, { tipo: a.destino_tipo, id: a.destino_id });
      }
      todosOsNos = Array.from(nosMap.values());
    }

    // 3) Aplica o cap por grafo: trunca o conjunto de nos e restringe as
    //    arestas as internas ao conjunto visivel (sem cross-attribution).
    const truncado = todosOsNos.length > cap;
    const nosVisiveis = truncado ? todosOsNos.slice(0, cap) : todosOsNos;

    let arestasVisiveis: RelacaoRow[];
    if (params.noId) {
      // Ancorado: buscamos as arestas internas ao conjunto visivel.
      arestasVisiveis = await coletarArestasEntreNos(db, tipo, nosVisiveis);
    } else if (truncado) {
      const chaveVisivel = new Set(nosVisiveis.map((n) => `${n.tipo}:${n.id}`));
      arestasVisiveis = arestasBrutas!.filter((a) =>
        chaveVisivel.has(`${a.origem_tipo}:${a.origem_id}`) &&
        chaveVisivel.has(`${a.destino_tipo}:${a.destino_id}`)
      );
    } else {
      arestasVisiveis = arestasBrutas!;
    }

    // 4) Formatacao para a UI (label/icone/cor + descritor).
    const nos = await formatarNos(db, orgId, nosVisiveis);
    const arestas = formatarArestas(arestasVisiveis);

    return jsonResponse(
      {
        nos,
        arestas,
        cap,
        truncado,
        tipo,
        gerado_em: new Date().toISOString(),
      },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
