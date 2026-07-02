// =====================================================================
// Edge Function: relacionamentos-buscar-split  (Relacionamentos V2 - dois grafos)
//   -> POST /functions/v1/relacionamentos-buscar-split
//
// MCP read-only da Lia (tool relacionamentos_buscar_split): recebe uma
// consulta em linguagem natural e devolve, EM PARALELO, os dois subgrafos
// distintos (hierarquico e semantico) ancorados nos documentos que a busca
// vetorial encontrar.
//
// Contrato:
//   Input:  { consulta, profundidade?, filtros?, limites? }
//   Output: {
//     hierarquico: { nos, arestas },
//     semantico:   { nos, arestas },
//     meta: { profundidade_aplicada, cap_aplicado, truncado, gerado_em }
//   }
//
// Regras (criterios de aceite):
//   * Autenticacao por authenticateV1 (X-Service-Token / API key da Lia,
//     escopo read-only:busca-semantica). Sessao humana NAO e aceita.
//   * profundidade default 2, teto duro 5 (clamp SERVER-SIDE em [1, 5]
//     ANTES da query, para evitar explosao de subgrafo).
//   * max_nos_por_grafo (cap) lido de config_relacionamentos.cap_por_grafo
//     (precedencia cap_por_grafo ?? 200). O override em
//     limites.max_nos_por_grafo, quando presente, e clampado e NUNCA
//     aumenta o cap da org.
//   * Reusa a RPC compartilhada public.relacoes_vizinhanca JA sem filtro
//     de status legado (F1): NAO filtra status; EXCLUI arestas
//     incorreta=true; restringe a travessia ao tipo_relacionamento pedido.
//   * Rota de LEITURA: NAO grava audit_log (invariante PRD B.0/B.5/SEC-3).
//     Apenas logging estruturado JSON (console.info).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, LIA_SERVICE_SCOPE, principalLabel } from "../_shared/service-auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { resolveEmbeddingProvider } from "../_shared/indexacao.ts";
import { EmbeddingError } from "../_shared/embeddings.ts";
import { resolverNosVisual } from "../_shared/relacionamentos-nos.ts";
import {
  parseJsonBody,
  RELACIONAMENTOS_TIPOS_GRAFO,
  type RelacionamentosBuscarSplitPayload,
  relacionamentosBuscarSplitPayloadSchema,
  type RelacionamentoTipoGrafo,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-buscar-split";

/** Profundidade default e teto duro (clamp server-side em [1, 5]). */
const DEFAULT_PROFUNDIDADE = 2;
const MIN_PROFUNDIDADE = 1;
const MAX_PROFUNDIDADE = 5;

/** Default interno de cap POR GRAFO quando a org nao definiu cap. */
const DEFAULT_CAP = 200;

/** Teto de ancoras (documentos) usadas para expandir os subgrafos. */
const MAX_ANCORAS = 5;

/** Quantidade de chunks/documentos recuperados pela busca vetorial. */
const DOC_LIMITE = 10;

/** Colunas de public.relacoes que o handler consulta. */
const REL_COLS =
  "origem_tipo, origem_id, destino_tipo, destino_id, relacao, metodo, confianca";

type ServiceClient = ReturnType<typeof createServiceClient>;

// ---------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------
interface AcervoRow {
  documento_id: string | null;
}

interface VizinhoRpcRow {
  tipo: string;
  id: string;
  profundidade: number;
  caminho: string[];
}

interface RelacaoRow {
  origem_tipo: string;
  origem_id: string;
  destino_tipo: string;
  destino_id: string;
  relacao: string;
  metodo: "deterministico" | "sugerido";
  confianca: number;
}

interface NoRef {
  tipo: string;
  id: string;
}

interface NoVisual {
  tipo: string;
  id: string;
  label: string;
  icone: string;
  cor: string;
  estado: string;
}

interface ArestaVisual {
  origem_tipo: string;
  origem_id: string;
  destino_tipo: string;
  destino_id: string;
  relacao: string;
  metodo: "deterministico" | "sugerido";
  confianca: number;
}

interface Subgrafo {
  nos: NoVisual[];
  arestas: ArestaVisual[];
}

// ---------------------------------------------------------------------
// Busca vetorial (mesmo caminho da v1-relacionamentos-buscar).
// ---------------------------------------------------------------------
async function gerarEmbeddingConsulta(consulta: string): Promise<number[]> {
  const provider = await resolveEmbeddingProvider();
  try {
    const [vector] = await provider.embed([consulta]);
    if (!vector) throw new EmbeddingError("provider nao retornou embedding para a consulta");
    return vector;
  } catch (err) {
    if (err instanceof EmbeddingError) {
      throw new HttpError(
        502,
        "embedding_indisponivel",
        "falha ao gerar o embedding da consulta; servico de embeddings indisponivel",
      );
    }
    throw err;
  }
}

async function buscarDocumentosAncora(
  db: ServiceClient,
  queryVector: number[],
  limite: number,
): Promise<string[]> {
  const { data, error } = await db.rpc("busca_semantica_documentos", {
    p_embedding: queryVector,
    p_limite: limite,
  });
  if (error) {
    throw new HttpError(500, "busca_semantica_failed", "falha ao executar a busca semantica");
  }
  const ids = ((data ?? []) as AcervoRow[])
    .map((row) => row.documento_id)
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------
// Expansao de UM subgrafo (por tipo de relacionamento).
// ---------------------------------------------------------------------
async function expandirAncora(
  db: ServiceClient,
  documentoId: string,
  profundidade: number,
  tipo: RelacionamentoTipoGrafo,
): Promise<VizinhoRpcRow[]> {
  const { data, error } = await db.rpc("relacoes_vizinhanca", {
    p_tipo: "documento",
    p_id: documentoId,
    p_profundidade: profundidade,
    p_tipo_relacionamento: tipo,
  });
  if (error) {
    // Best-effort por ancora: uma falha nao derruba o subgrafo inteiro.
    console.warn(JSON.stringify({
      fn: FUNCTION_SEGMENT,
      evento: "expandir_ancora_falhou",
      tipo,
      documento_id: documentoId,
      mensagem: error.message,
    }));
    return [];
  }
  return (data ?? []) as VizinhoRpcRow[];
}

/**
 * Arestas INTERNAS a um conjunto de nos (ambas as pontas visiveis), do tipo
 * pedido e nao incorretas. Toda aresta interna tem sua origem no conjunto,
 * logo filtramos por origem_id IN ids e conferimos as duas pontas.
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
    throw new HttpError(500, "relacoes_query_failed", "falha ao listar arestas do subgrafo");
  }
  const chavesVisiveis = new Set(nos.map((n) => `${n.tipo}:${n.id}`));
  return ((data ?? []) as RelacaoRow[]).filter((a) =>
    chavesVisiveis.has(`${a.origem_tipo}:${a.origem_id}`) &&
    chavesVisiveis.has(`${a.destino_tipo}:${a.destino_id}`)
  );
}

interface MontarSubgrafoResult {
  subgrafo: Subgrafo;
  truncado: boolean;
}

async function montarSubgrafo(
  db: ServiceClient,
  tipo: RelacionamentoTipoGrafo,
  documentoIds: ReadonlyArray<string>,
  profundidade: number,
  cap: number,
  tiposFiltro: Set<string> | null,
): Promise<MontarSubgrafoResult> {
  // Expande a vizinhanca de cada ancora (em paralelo) restrita ao tipo.
  const vizinhancas = await Promise.all(
    documentoIds.map((id) => expandirAncora(db, id, profundidade, tipo)),
  );

  // Universo de nos: ancoras (documentos) + vizinhos, deduplicados por chave.
  const nosMap = new Map<string, NoRef>();
  for (const id of documentoIds) {
    nosMap.set(`documento:${id}`, { tipo: "documento", id });
  }
  for (const rows of vizinhancas) {
    for (const row of rows) {
      nosMap.set(`${row.tipo}:${row.id}`, { tipo: row.tipo, id: row.id });
    }
  }

  let todosOsNos = Array.from(nosMap.values());
  if (tiposFiltro) {
    todosOsNos = todosOsNos.filter((n) => tiposFiltro.has(n.tipo));
  }

  // Cap por grafo: trunca o conjunto de nos deterministicamente.
  const truncado = todosOsNos.length > cap;
  const nosVisiveis = truncado ? todosOsNos.slice(0, cap) : todosOsNos;

  const arestasBrutas = await coletarArestasEntreNos(db, tipo, nosVisiveis);

  // Resolve label/icone/cor/estado (mapa canonico org-agnostico das MCPs).
  const visuais = await resolverNosVisual(db, nosVisiveis);
  const nos: NoVisual[] = nosVisiveis.map((n) => {
    const v = visuais.get(`${n.tipo}:${n.id}`);
    return v ?? {
      tipo: n.tipo,
      id: n.id,
      label: `${n.tipo}:${n.id}`,
      icone: "circle",
      cor: "#a1a1aa",
      estado: "desconhecido",
    };
  });

  const arestas: ArestaVisual[] = arestasBrutas.map((a) => ({
    origem_tipo: a.origem_tipo,
    origem_id: a.origem_id,
    destino_tipo: a.destino_tipo,
    destino_id: a.destino_id,
    relacao: a.relacao,
    metodo: a.metodo,
    confianca: Number(a.confianca),
  }));

  return { subgrafo: { nos, arestas }, truncado };
}

// ---------------------------------------------------------------------
// Cap efetivo por grafo (config org-agnostica + override de limites).
// ---------------------------------------------------------------------
async function resolverCapPorGrafo(
  db: ServiceClient,
  override: number | undefined,
): Promise<number> {
  const { data, error } = await db
    .from("config_relacionamentos")
    .select("cap_por_grafo")
    .limit(1);
  if (error) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar configuracao");
  }
  const cfg = ((data ?? [])[0] ?? null) as
    | { cap_por_grafo: number | null }
    | null;
  let cap = cfg?.cap_por_grafo ?? DEFAULT_CAP;
  if (!Number.isInteger(cap) || cap < 1) cap = DEFAULT_CAP;
  // Override NUNCA aumenta o cap da org (apenas restringe).
  if (override !== undefined && override >= 1) {
    cap = Math.min(cap, Math.trunc(override));
  }
  return cap;
}

// ---------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Borda: exclusivo de servico (API key da Lia read-only). Sessao humana
    // resulta em 403 escopo_invalido (nunca recai para requireAuthorizedUser).
    const principal = await authenticateV1(req, { requiredScope: LIA_SERVICE_SCOPE });

    const payload: RelacionamentosBuscarSplitPayload = await parseJsonBody(
      req,
      relacionamentosBuscarSplitPayloadSchema,
      { validationStatus: 422 },
    );

    // Clamp de profundidade SERVER-SIDE (teto duro), ANTES de qualquer query.
    const profundidade = Math.max(
      MIN_PROFUNDIDADE,
      Math.min(MAX_PROFUNDIDADE, payload.profundidade ?? DEFAULT_PROFUNDIDADE),
    );

    const db = createServiceClient();
    const cap = await resolverCapPorGrafo(db, payload.limites?.max_nos_por_grafo);
    const maxAncoras = payload.limites?.max_ancoras !== undefined
      ? Math.min(MAX_ANCORAS, Math.trunc(payload.limites.max_ancoras))
      : MAX_ANCORAS;

    const tiposFiltro = payload.filtros?.tipos_no && payload.filtros.tipos_no.length > 0
      ? new Set(payload.filtros.tipos_no)
      : null;

    // 1) Busca vetorial -> documentos ancora.
    const queryVector = await gerarEmbeddingConsulta(payload.consulta);
    const documentoIds = (await buscarDocumentosAncora(db, queryVector, DOC_LIMITE))
      .slice(0, maxAncoras);

    // 2) Dois subgrafos EM PARALELO (hierarquico + semantico).
    const [hierarquicoResult, semanticoResult] = await Promise.all(
      RELACIONAMENTOS_TIPOS_GRAFO.map((tipo) =>
        montarSubgrafo(db, tipo, documentoIds, profundidade, cap, tiposFiltro)
      ),
    );

    const truncado = hierarquicoResult.truncado || semanticoResult.truncado;
    const gerado_em = new Date().toISOString();

    // Rota de LEITURA: sem audit_log. Apenas logging estruturado JSON.
    console.info(JSON.stringify({
      fn: FUNCTION_SEGMENT,
      evento: "buscar_split",
      principal: principalLabel(principal),
      via: principal.kind,
      profundidade_aplicada: profundidade,
      cap_aplicado: cap,
      ancoras: documentoIds.length,
      hierarquico_nos: hierarquicoResult.subgrafo.nos.length,
      hierarquico_arestas: hierarquicoResult.subgrafo.arestas.length,
      semantico_nos: semanticoResult.subgrafo.nos.length,
      semantico_arestas: semanticoResult.subgrafo.arestas.length,
      truncado,
    }));

    return jsonResponse(
      {
        hierarquico: hierarquicoResult.subgrafo,
        semantico: semanticoResult.subgrafo,
        meta: {
          profundidade_aplicada: profundidade,
          cap_aplicado: cap,
          truncado,
          gerado_em,
        },
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
