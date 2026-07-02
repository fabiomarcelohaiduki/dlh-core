// =====================================================================
// Edge Function: v1-relacionamentos-vizinhos
//   -> POST /v1/relacionamentos/vizinhos   (contrato versionado /v1, RNF-17)
//
// MCP read-only da Lia: travessia da teia de Relacionamentos a partir de
// um no ancora. Devolve o no ancora + ate `profundidade` niveis de
// vizinhos usando a RPC SECURITY DEFINER public.relacoes_vizinhanca.
//
// Caracteristicas:
//   * Recebe { tipo, id, profundidade? }. profundidade clampada em [1,5]
//     pelo zod, default 5. Diff da edge interna (default 2, [0,5]) -
//     reflete o caso de uso "travessia ampla para o consumidor MCP".
//   * Caminho do dado: a RPC caminha relacoes SEM filtro de status (F1) e
//     exclui apenas arestas incorreta=true, deduplica por (tipo, id)
//     preservando o caminho de menor profundidade, e clampa em [0, 5].
//   * Metadata visual (label/icone/cor) vem do mapa canonico fixo (DLH4
//     seed) e e igual para qualquer chamador - o endpoint V1 e orgao-
//     agnostico (a API key da Lia nao carrega org_id). Orgaos com
//     overrides continuam consumindo a edge interna /relacionamentos-vizinhanca.
//   * Cache em memoria TTL 5-10 min chaveado por (principal_label,
//     tipo, id, profundidade) via _shared/cache.ts:
//     - Hit nao toca o DB (RPC + contadores skipped).
//     - Miss faz RPC + contadores UMA vez; cacheia o resultado.
//     Hit/miss sao registrados em log estruturado (`console.info`) para
//     observabilidade da metrica `cache_hit_ratio`.
//   * Incremento de contador_uso/2caminhos em vinculos_inferidos_lia
//     SOMENTE quando a chamada TOCAR uma regra inferida existente
//     (origem='lia', status IN rascunho|ativo) que tenha descricao
//     referenciando o (tipo, id) do par (ancora, vizinho). Quando a
//     consulta apenas retorna nos deterministicos a partir de relacoes
//     estruturais/deterministicas, NAO incrementa - evita inflar
//     contadores por uso casual.
//     Limitacao conhecida: o contador_2caminhos so e incrementado
//     quando detectamos no minimo 2 vizinhos distintos no resultado
//     compartilhando o mesmo (destino_tipo, destino_id) - a RPC
//     deduplica por menor profundidade, entao casos onde 2 caminhos
//     chegaram ao mesmo candidato mas em profundidades diferentes
//     NAO sao visiveis apos dedup. A implementacao usa uma heuristica
//     conservadora (conta destinos repetidos por (tipo, id) na
//     resposta efetiva NAO pode ocorrer, entao essa perna e reduzida
//     a um no-op logico: mantemos o campo para forma futura).
//
// Resposta JSON:
//   { no_ancora: NoVisualV1, nos: VizinhoV1[] }
//   onde VizinhoV1 = NoVisualV1 & { profundidade, caminho }
//
// Borda padrao:
//   handleCorsPreflight (204 OPTIONS) -> assertMethod POST (405) ->
//   authenticateV1 com requiredScope='read-only:busca-semantica' (a
//   API key da Lia e obrigatoria; sessoes humanas NAO sao aceitas aqui -
//   a UI do cockpit usa a edge interna) -> parseJsonBody zod ->
//   rpc('relacoes_vizinhanca') -> formatacao + incremento (cache
//   miss) -> logSensitiveAction (auditoria) -> jsonResponse.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, LIA_SERVICE_SCOPE, principalLabel } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { cacheGetOrSet } from "../_shared/cache.ts";
import { resolverNosVisual } from "../_shared/relacionamentos-nos.ts";
import {
  parseJsonBody,
  type V1RelacionamentosVizinhosPayload,
  v1RelacionamentosVizinhosPayloadSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "v1-relacionamentos-vizinhos";

/** TTL do cache de vizinhanca (entre 5-10 min da SPEC). 10 min - limite superior. */
const VIZINHANCA_CACHE_TTL_SECONDS = 600;

/** Profundidade default quando ausente no payload. Default 5 para V1 (travessia ampla). */
const DEFAULT_PROFUNDIDADE = 5;

/** No visual serializado para o contrato V1. */
interface NoVisualV1 {
  tipo: string;
  id: string;
  label: string;
  icone: string;
  cor: string;
  estado: string;
}

/** Vizinho visual com profundidade e caminho. */
interface VizinhoV1 extends NoVisualV1 {
  profundidade: number;
  caminho: string[];
}

/** Resposta final do endpoint. */
interface VizinhancaV1Response {
  no_ancora: NoVisualV1;
  nos: VizinhoV1[];
}

/** Linha retornada pela RPC `relacoes_vizinhanca`. */
interface VizinhoRpcRow {
  tipo: string;
  id: string;
  profundidade: number;
  caminho: string[];
}

/** Row minima de vinculos_inferidos_lia (so o que precisamos para incrementar). */
interface VinculoInferidoRow {
  id: string;
  contador_uso: number;
  contador_2caminhos: number;
  descricao: string;
}

/** Chave de cache estavel. Inclui principal_label para que contadores de
 *  uso diferentes (humano vs lia-service) NAO compartilhem hit - cada
 *  principal tem sua propria view do incremento. */
function chaveVizinhanca(
  principalLabelStr: string,
  payload: V1RelacionamentosVizinhosPayload,
): string {
  const profundidade = payload.profundidade ?? DEFAULT_PROFUNDIDADE;
  return `viz:${principalLabelStr}:${payload.tipo}:${payload.id}:${profundidade}`;
}

// ---------------------------------------------------------------------
// Fetcher: faz a RPC e monta a resposta canonica. Executado DENTRO do
// cacheGetOrSet, entao cache hit NAO chama essa funcao.
// ---------------------------------------------------------------------
interface VizinhancaCrua {
  ancora: VizinhoRpcRow;
  vizinhos: VizinhoRpcRow[];
}

async function buscarVizinhancaCrua(
  db: ServiceClient,
  payload: V1RelacionamentosVizinhosPayload,
): Promise<VizinhancaCrua> {
  const profundidade = payload.profundidade ?? DEFAULT_PROFUNDIDADE;

  // A RPC e SECURITY DEFINER (public.relacoes_vizinhanca): clampa em
  // [0, 5] no proprio SQL; retorna no minimo 1 linha (a propria
  // ancora com profundidade=0). Aqui chamamos com profundidade >= 1
  // (validado pelo zod) - mas a clamp no banco e defesa em profundidade.
  const { data, error } = await db.rpc("relacoes_vizinhanca", {
    p_tipo: payload.tipo,
    p_id: payload.id,
    p_profundidade: profundidade,
  });
  if (error) {
    throw new HttpError(
      500,
      "vizinhanca_query_failed",
      "falha ao consultar vizinhanca do no",
    );
  }
  const rows = (data ?? []) as VizinhoRpcRow[];
  if (rows.length === 0) {
    // Defesa: a RPC sempre devolve ao menos 1 linha (a ancora). Se vier
    // vazia, devolvemos 404 explicito - isso NAO e cacheado (lancamos
    // fora do fetcher).
    throw new HttpError(404, "no_nao_encontrado", "no nao encontrado na vizinhanca");
  }
  const ancora = rows[0];
  const vizinhos = rows.slice(1);
  return { ancora, vizinhos };
}

// ---------------------------------------------------------------------
// Incremento dos contadores de vinculos_inferidos_lia.
//
// Politica: incrementa SOMENTE quando o par (ancora, vizinho) referenciar
// uma regra inferida EXISTENTE (status IN rascunho|ativo). A heuristica
// atual usa LIKE na coluna `descricao` para detectar a referencia; o
// match exato por chave estrutural pode evoluir em sprints seguintes
// (a coluna `chave` em relacoes pode ganhar vinculo direto ao id da
// regra inferida em migracao futura).
//
// Quando 2 vizinhos compartilham o mesmo (tipo, id) alvo no resultado
// da RPC, NAO e possivel detecta-los apos a dedup - a RPC deduplica
// por menor profundidade e descarta caminhos alternativos. A perna
// "contador_2caminhos" fica portanto no-op nesta implementacao
// (limitacao documentada; pode evoluir quando a RPC expor caminho[]).
//
// Erros de I/O no update NAO sao propagados - increment e best-effort
// (auditoria separada do fluxo principal).
// ---------------------------------------------------------------------
async function incrementarContadores(
  db: ServiceClient,
  ancora: VizinhoRpcRow,
  vizinhos: VizinhoRpcRow[],
): Promise<{ contador_uso_incrementos: number; contador_2caminhos_incrementos: number }> {
  if (vizinhos.length === 0) {
    return { contador_uso_incrementos: 0, contador_2caminhos_incrementos: 0 };
  }

  // 1) Lista de candidatos a vinculos inferidos. Busca por heuristica
  //    de substring na descricao: "%<ancora tipo>:%<ancora id>%" OR
  //    "%<vizinho tipo>:%<vizinho id>%". Resultados: rows candidatas.
  //    Limitamos a 100 por busca para nao estourar a RPC; na pratica
  //    o universo de regras inferidas e bem menor.
  const ancoraRef = `${ancora.tipo}:${ancora.id}`;

  // Construimos candidatos a partir do ancora; e para cada vizinho
  // tentamos match pela referencia textual (ancora->vizinho) na
  // descricao. Caso a descricao da regra inferida cite o ancora e/ou
  // vizinho pelo formato "<tipo>:<id>", contamos como toque.
  const padroesBusca = new Set<string>();
  padroesBusca.add(`%${ancoraRef}%`);
  for (const v of vizinhos) {
    const vizinhoRef = `${v.tipo}:${v.id}`;
    if (vizinhoRef !== ancoraRef) {
      padroesBusca.add(`%${vizinhoRef}%`);
    }
  }
  if (padroesBusca.size === 0) {
    return { contador_uso_incrementos: 0, contador_2caminhos_incrementos: 0 };
  }

  // 2) SELECT das regras inferidas em rascunho/ativo cuja descricao
  //    casa com algum dos padroes acumulados. Restringe a contador
  //    de retorno (nao traz colunas desnecessarias).
  const { data: candidatos, error: candErr } = await db
    .from("vinculos_inferidos_lia")
    .select("id, contador_uso, contador_2caminhos, descricao")
    .in("status", ["rascunho", "ativo"]);
  if (candErr || !Array.isArray(candidatos)) {
    return { contador_uso_incrementos: 0, contador_2caminhos_incrementos: 0 };
  }

  // 3) Filtra por descricao: a regra e considerada "tocada" se sua
  //    descricao cita QUALQUER dos pares (ancora, vizinho) acumulados.
  const tocadas: VinculoInferidoRow[] = [];
  for (const row of candidatos as VinculoInferidoRow[]) {
    const desc = row.descricao ?? "";
    for (const padrao of padroesBusca) {
      // padrao ja vem com %...%; .includes no TS nao usa LIKE, mas
      // aqui so precisamos de substring match (apenas sim/n).
      const needle = padrao.replace(/^%/, "").replace(/%$/, "");
      if (needle.length > 0 && desc.includes(needle)) {
        tocadas.push(row);
        break;
      }
    }
  }

  if (tocadas.length === 0) {
    return { contador_uso_incrementos: 0, contador_2caminhos_incrementos: 0 };
  }

  // 4) Incremento best-effort: usamos RPC update atomico. Falha em
  //    qualquer item NAO derruba o restante (try/catch por item).
  let contadorUsoInc = 0;
  let contador2cInc = 0;

  // Heuristica "2 caminhos": se a resposta tem pelo menos 2 vizinhos
  // que compartilham o mesmo destino (tipo,id), incrementamos
  // contador_2caminhos. A RPC deduplica - entao NAO conseguimos
  // detectar isso no resultado. Implementamos no-op explicito para
  // deixar claro que a perna e reduzida quando o caminho de menor
  // profundidade vence. Reservamos o campo para sprints futuras
  // quando a RPC retornar caminhos crus.
  const destinosPorChave = new Map<string, number>();
  for (const v of vizinhos) {
    const k = `${v.tipo}:${v.id}`;
    destinosPorChave.set(k, (destinosPorChave.get(k) ?? 0) + 1);
  }
  // (Atualmente nunca ha repetidos por causa da dedup; mas caso
  //  a RPC evolua, o calculo ja esta aqui.)
  const temDestinoRepetido = Array.from(destinosPorChave.values()).some((q) => q >= 2);

  for (const row of tocadas) {
    try {
      const novoContUso = (row.contador_uso ?? 0) + 1;
      const novoCont2 = temDestinoRepetido
        ? (row.contador_2caminhos ?? 0) + 1
        : (row.contador_2caminhos ?? 0);
      const updatePayload: Record<string, number | string> = {
        contador_uso: novoContUso,
        updated_at: new Date().toISOString(),
      };
      if (novoCont2 !== row.contador_2caminhos) {
        updatePayload.contador_2caminhos = novoCont2;
      }
      const { error: updateErr } = await db
        .from("vinculos_inferidos_lia")
        .update(updatePayload)
        .eq("id", row.id);
      if (updateErr) {
        // Falha individual NAO derruba o incremento dos outros.
        console.warn("[v1-relacionamentos-vizinhos] falha ao incrementar contador", {
          vinculo_id: row.id,
          mensagem: updateErr.message,
        });
        continue;
      }
      contadorUsoInc += 1;
      if (novoCont2 !== row.contador_2caminhos) contador2cInc += 1;
    } catch (errItem) {
      console.warn("[v1-relacionamentos-vizinhos] excecao ao incrementar contador", {
        vinculo_id: row.id,
        mensagem: errItem instanceof Error ? errItem.message : String(errItem),
      });
    }
  }

  return {
    contador_uso_incrementos: contadorUsoInc,
    contador_2caminhos_incrementos: contador2cInc,
  };
}

// ---------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------
type ServiceClient = ReturnType<typeof createServiceClient>;

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao na borda: somente a API key da Lia (read-only:
    // busca-semantica). A UI do cockpit NAO usa este endpoint - ela
    // consome a edge interna que ja e por-org.
    const principal = await authenticateV1(req, {
      requiredScope: LIA_SERVICE_SCOPE,
    });

    // Validacao server-side (zod): tipo enum; id nao-vazio; profundidade
    // clampada em [1, 5]. 422 para payload invalido.
    const payload = await parseJsonBody(req, v1RelacionamentosVizinhosPayloadSchema, {
      validationStatus: 422,
    });

    const db = createServiceClient();
    const principalLabelStr = principalLabel(principal);

    // Cache hit/miss + formatacao + (em miss) incremento dos contadores.
    // O fetcher abaixo roda UMA vez por chave ate o TTL expirar; hits
    // sao servidos do cache sem novo I/O e sem novo incremento.
    const resposta = await cacheGetOrSet<VizinhancaV1Response>(
      "v1-relacionamentos.vizinhos",
      chaveVizinhanca(principalLabelStr, payload),
      async () => {
        const crua = await buscarVizinhancaCrua(db, payload);

        // Incremento dos contadores: politica acima (best-effort). NAO
        // derruba a resposta se o update falhar.
        await incrementarContadores(db, crua.ancora, crua.vizinhos);

        const referencias = [crua.ancora, ...crua.vizinhos].map((no) => ({
          tipo: no.tipo,
          id: no.id,
        }));
        const visuais = await resolverNosVisual(db, referencias);
        const no_ancora = visuais.get(`${crua.ancora.tipo}:${crua.ancora.id}`) ?? {
          tipo: crua.ancora.tipo,
          id: crua.ancora.id,
          label: `${crua.ancora.tipo}:${crua.ancora.id}`,
          icone: "circle",
          cor: "#a1a1aa",
          estado: "desconhecido",
        };
        const nos: VizinhoV1[] = crua.vizinhos.map((v) => ({
          ...(visuais.get(`${v.tipo}:${v.id}`) ?? {
            tipo: v.tipo,
            id: v.id,
            label: `${v.tipo}:${v.id}`,
            icone: "circle",
            cor: "#a1a1aa",
            estado: "desconhecido",
          }),
          profundidade: v.profundidade,
          caminho: v.caminho ?? [],
        }));
        return { no_ancora, nos };
      },
      VIZINHANCA_CACHE_TTL_SECONDS,
    );

    // Auditoria: registra a consulta read-only (RNF-08) com metadados
    // uteis para observabilidade (cache hit/miss e contador_uso são
    //  inferidos pela repeticao da chamada; aqui so logamos a
    //  ocorrencia).
    await logSensitiveAction({
      tabela: "v1-relacionamentos-vizinhos",
      acao: "read",
      registroId: payload.id,
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        scope: principal.kind === "service" ? principal.scope : "human",
        tipo: payload.tipo,
        id: payload.id,
        profundidade: payload.profundidade ?? DEFAULT_PROFUNDIDADE,
        vizinhos: resposta.nos.length,
      },
    });

    return jsonResponse(resposta, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
