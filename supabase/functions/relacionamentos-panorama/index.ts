// =====================================================================
// Edge Function: relacionamentos-panorama
//
// GET /functions/v1/relacionamentos-panorama
//
// Retorna a "fotografia" capada do grafo de Relacionamentos para o
// cockpit. A UI consome este endpoint para renderizar a visao geral
// (mapa de nos/arestas) sem precisar chamar a RPC recursiva.
//
// Comportamento (sprint "Edge Functions de Leitura (panorama e
// vizinhanca) com cache"):
//   * Lista todos os nos que possuem >= 1 aresta com status='confirmado'
//     em public.relacoes.
//   * Aplica cap_panorama da config_relacionamentos da org (campo
//     opcional). Default interno aplicado APENAS quando o campo e
//     NULL na config (UI ainda nao definiu). Default: 200.
//   * Quando o universo de nos excede cap, retorna truncado=true e
//     inclui apenas os primeiros `cap` nos e as arestas entre esses
//     nos (sem cross-attribution com nos descartados).
//   * Resolve label/icone/cor por tipo usando config_tipos_no da org.
//   * NAO grava audit_log (rota de leitura - mesma politica da
//     v1-substrato-busca-semantica).
//
// Resposta JSON:
//   { nos: NoVisual[], arestas: ArestaVisual[], cap: int, truncado: boolean }
//
// Borda padrao:
//   handleCorsPreflight -> assertMethod GET (405 para outros) ->
//   requireAuthorizedUser (401/403) -> resolucao de org_id via
//   org_membership -> leitura (config + relacoes + tipos) ->
//   formatacao -> jsonResponse.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";

const FUNCTION_SEGMENT = "relacionamentos-panorama";

/** Default interno aplicado SOMENTE quando cap_panorama e NULL. */
const DEFAULT_CAP_PANORAMA = 200;

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

/** Linha minima de config_relacionamentos. */
interface ConfigRow {
  cap_panorama: number | null;
}

type ServiceClient = ReturnType<typeof createServiceClient>;

// ---------------------------------------------------------------------
// Resolucao de descritores (label rico por tipo de no).
// ---------------------------------------------------------------------

/** Tamanho maximo (chars) do label retornado para a UI. */
const LABEL_MAX_CHARS = 80;

/**
 * Mapeamento tipo de no -> tabela que expoe o nome real da entidade.
 * Para cada tipo presente no universo visivel, disparamos 1 SELECT
 * com WHERE id IN (...) em paralelo (Promise.all), e usamos o resultado
 * como label "rico" do no. Tipos sem entrada caem no label generico
 * do config_tipos_no (preco/politica/cotacao_diretriz, por exemplo,
 * nao tem nome humano).
 */
interface TabelaDescritor {
  /** Coluna retornada como label. */
  campo: string;
  /** Quando definido, compoe o label como `${prefixo}${valor}`. */
  prefixo?: string;
  /** Quando definido, concatena com o valor de outra coluna da mesma linha. */
  tambem?: { campo: string; separador: string; prefixo?: string };
}

const TABELAS_DESCRITOR: Record<string, TabelaDescritor> = {
  documento: { campo: "nome_arquivo" },
  aviso: { campo: "objeto", prefixo: "" , tambem: { campo: "orgao", separador: " · ", prefixo: "" } },
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

/**
 * Carrega os descritores (label rico) para cada no visivel, agrupando
 * por tipo e disparando 1 SELECT por tipo em paralelo. Retorna um Map
 * chaveado por "tipo:id" -> label pronto para a UI.
 *
 * Nos sem entrada no Map caem no label generico do config_tipos_no
 * (comportamento mantido).
 */
async function resolverDescritores(
  db: ServiceClient,
  nos: ReadonlyArray<{ tipo: string; id: string }>,
): Promise<Map<string, string>> {
  // Agrupa ids por tipo presente.
  const idsPorTipo = new Map<string, string[]>();
  for (const n of nos) {
    if (!TABELAS_DESCRITOR[n.tipo]) continue;
    const arr = idsPorTipo.get(n.tipo) ?? [];
    arr.push(n.id);
    idsPorTipo.set(n.tipo, arr);
  }
  if (idsPorTipo.size === 0) return new Map();

  // Dispara 1 SELECT por tipo em paralelo.
  const promises = Array.from(idsPorTipo.entries()).map(async ([tipo, ids]) => {
    const cfg = TABELAS_DESCRITOR[tipo];
    const colunas = cfg.tambem ? `${cfg.campo}, ${cfg.tambem.campo}` : cfg.campo;
    const { data, error } = await db
      .from(tabelaDoTipo(tipo))
      .select(`id, ${colunas}`)
      .in("id", ids);
    if (error) {
      // Falha transitória: loga e devolve mapa vazio deste tipo (cai no
      // fallback generico). NAO quebra o panorama por causa disso.
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
      // Tipos sem mapeamento aqui NUNCA chegam (filtro em resolverDescritores).
      return tipo;
  }
}

// ---------------------------------------------------------------------
// Resolucao visual do tipo (label/icone/cor).
// ---------------------------------------------------------------------
async function carregarTiposDaOrg(
  db: ServiceClient,
  orgId: string,
): Promise<TipoNoRow[]> {
  const { data, error } = await db
    .from("config_tipos_no")
    .select("tipo, label, icone, cor, ativo")
    .eq("org_id", orgId);
  if (error) {
    throw new HttpError(500, "tipos_query_failed", "falha ao consultar tipos de no da org");
  }
  return (data ?? []) as TipoNoRow[];
}

async function resolverTipos(
  db: ServiceClient,
  orgId: string,
): Promise<Map<string, TipoNoRow>> {
  const rows = await carregarTiposDaOrg(db, orgId);
  const mapa = new Map<string, TipoNoRow>();
  for (const row of rows) {
    mapa.set(row.tipo, row);
  }
  return mapa;
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

    // 1) Cap da org (default interno quando NULL).
    const { data: cfgRow, error: cfgError } = await db
      .from("config_relacionamentos")
      .select("cap_panorama")
      .eq("org_id", orgId)
      .maybeSingle();
    if (cfgError) {
      throw new HttpError(500, "config_query_failed", "falha ao consultar configuracao da org");
    }
    const cfg = (cfgRow ?? null) as ConfigRow | null;
    const cap = cfg?.cap_panorama ?? DEFAULT_CAP_PANORAMA;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new HttpError(500, "config_cap_invalido", "cap_panorama da org e invalido");
    }

    // 2) Coleta TODAS as arestas confirmadas (origem/destino) em uma unica
    //    passada. O universo e GLOBAL (sem org_id), por isso nao filtramos
    //    por org aqui. Tabelas pequenas o suficiente para caber em uma
    //    pagina padrao do PostgREST.
    const REL_COLS =
      "origem_tipo, origem_id, destino_tipo, destino_id, relacao, metodo, chave, confianca";
    const { data: arestasRaw, error: relError } = await db
      .from("relacoes")
      .select(REL_COLS)
      .eq("status", "confirmado");
    if (relError) {
      throw new HttpError(500, "relacoes_query_failed", "falha ao listar arestas confirmadas");
    }
    const arestas = (arestasRaw ?? []) as RelacaoRow[];

    // 3) Calcula universo de nos (origem + destino) com ordem estavel para
    //    garantir determinismo da truncagem (mesma entrada -> mesma saida).
    const nosMap = new Map<string, { tipo: string; id: string }>();
    for (const a of arestas) {
      nosMap.set(`${a.origem_tipo}:${a.origem_id}`, { tipo: a.origem_tipo, id: a.origem_id });
      nosMap.set(`${a.destino_tipo}:${a.destino_id}`, { tipo: a.destino_tipo, id: a.destino_id });
    }
    const todosOsNos = Array.from(nosMap.values());

    // 4) Aplica cap_panorama: se a quantidade de nos unicos > cap,
    //    trunca e ajusta arestas para apenas as internas ao conjunto.
    const truncado = todosOsNos.length > cap;
    const nosVisiveis = truncado ? todosOsNos.slice(0, cap) : todosOsNos;
    const chaveVisivel = new Set(nosVisiveis.map((n) => `${n.tipo}:${n.id}`));

    const arestasVisiveis = truncado
      ? arestas.filter((a) =>
        chaveVisivel.has(`${a.origem_tipo}:${a.origem_id}`) &&
        chaveVisivel.has(`${a.destino_tipo}:${a.destino_id}`)
      )
      : arestas;

    // 5) Resolve label/icone/cor via cache por (org_id, tipo).
    const tiposMap = await resolverTipos(db, orgId);

    // 6) Enriquece cada no com o nome real da entidade (descritor).
    //    1 SELECT por tipo presente (em paralelo, via Promise.all).
    //    Falha em qualquer descritor NAO derruba o panorama: cai no
    //    label generico do tipo via config_tipos_no.
    const descritores = await resolverDescritores(db, nosVisiveis);

    // 7) Formata nos com fallback para tipo desconhecido/inativo.
    const nosFormatados: NoVisual[] = nosVisiveis.map((n) => {
      const t = tiposMap.get(n.tipo);
      const descritor = descritores.get(`${n.tipo}:${n.id}`);
      if (t && t.ativo) {
        return {
          tipo: n.tipo,
          id: n.id,
          // Precedencia: descritor (nome real) > label generico do tipo.
          label: descritor ?? t.label,
          icone: t.icone,
          cor: t.cor,
        };
      }
      // Fallback: tipo nao cadastrado ou inativo. Mantemos `tipo` como
      // discriminante da UI e usamos placeholders estaveis.
      return {
        tipo: n.tipo,
        id: n.id,
        label: descritor ?? n.tipo,
        icone: "circle",
        cor: "#a1a1aa",
      };
    });

    // 7) Formata arestas (subset estavel: 7 campos da SPEC).
    const arestasFormatadas: ArestaVisual[] = arestasVisiveis.map((a) => ({
      origem_tipo: a.origem_tipo,
      origem_id: a.origem_id,
      destino_tipo: a.destino_tipo,
      destino_id: a.destino_id,
      relacao: a.relacao,
      metodo: a.metodo,
      confianca: Number(a.confianca),
    }));

    return jsonResponse(
      {
        nos: nosFormatados,
        arestas: arestasFormatadas,
        cap,
        truncado,
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
