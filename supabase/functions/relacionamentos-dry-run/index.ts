// =====================================================================
// Edge Function: relacionamentos-dry-run  ->  POST /relacionamentos-dry-run
//
// Simula o impacto de UMA regra do catalogo (catalogo_regras_vinculo) sobre
// o substrato REAL, SEM PERSISTIR nada (invariante read-only F3, feat-017):
// nunca escreve em `relacoes` nem em `catalogo_regras_vinculo`. Devolve a
// contagem projetada, uma amostra de arestas, a distribuicao por tipo, um
// `score_risco` (alertas SOFT + limite tecnico DURO), o `regra_hash` dos
// campos de matching e a `config_aplicada` (limiares da org).
//
// score_risco:
//   * alertas SOFT (nivel='aviso'): confianca baixa, cardinalidade alta,
//     duplicidade, origem=destino, amostra insuficiente. Usam os limiares
//     de config_relacionamentos.dry_run_limiares e apenas AVISAM - o humano
//     decide. NUNCA bloqueiam.
//   * limite tecnico DURO (nivel='bloqueio', limite_tecnico_atingido=true):
//     volume projetado > 50000 OU timeout de 30s (RNF-12). Timeout retorna
//     HTTP 408.
//
// Single-flight por regra/usuario (E14): disparos concorrentes do MESMO
// dry-run (mesma regra + mesmo usuario) sao coalescidos - o segundo request
// reaproveita o resultado do primeiro em voo (uma unica execucao no
// substrato). Rate limiting generico NAO faz parte do escopo.
//
// AUDITA (nao e leitura pura: e simulacao de mutacao): logSensitiveAction
// com tabela='catalogo_regras_vinculo', acao='relacionamento_dry_run'.
//
// Borda padrao:
//   handleCorsPreflight -> assertMethod POST (405) -> requireAuthorizedUser
//   (401/403) -> resolucao de org_id -> validacao zod (400) -> single-flight
//   -> simulacao com timeout -> auditoria -> jsonResponse.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";
import { coalesce } from "../_shared/single-flight.ts";
import { hashRegraMatching } from "../_shared/relacionamentos-regra-hash.ts";
import { carregarTabelasFonte } from "../_shared/relacionamentos-backfill.ts";
import {
  colunasSelect,
  ehJsonPath,
  extrairTupla,
  parseCampo,
} from "../_shared/relacionamentos-campos.ts";
import { parseJsonBody, relacionamentosDryRunSchema } from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-dry-run";

/** Tempo maximo da simulacao (RNF-12). Estouro => HTTP 408. */
const TIMEOUT_MS = 30_000;

/** Limite tecnico DURO de volume projetado (RNF-12). Acima => bloqueio. */
const VOLUME_LIMITE = 50_000;

/** Tamanho maximo da amostra de arestas devolvida a UI. */
const AMOSTRA_MAX = 20;

/** Limiares SOFT default (usados quando a org nao tem config gravada). */
const DEFAULT_LIMIARES: DryRunLimiares = {
  confianca_baixa: 0.5,
  cardinalidade_alta: 1000,
  duplicidade_pct: 0.2,
  amostra_insuficiente: 5,
};

type ServiceClient = ReturnType<typeof createServiceClient>;

// ---------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------

interface DryRunLimiares {
  confianca_baixa: number;
  cardinalidade_alta: number;
  duplicidade_pct: number;
  amostra_insuficiente: number;
}

/** Regra carregada do catalogo (campos de matching + identificacao). */
interface RegraRow {
  id: string;
  org_id: string;
  nome: string | null;
  origem_tipo: string;
  campo_origem: string;
  destino_tipo: string;
  campo_destino: string;
  combinacao: "simples" | "composta";
  sequencia: string[] | null;
}

/** Aresta visual (mesmo shape consumido pela UI no panorama). */
interface ArestaVisual {
  origem_tipo: string;
  origem_id: string;
  destino_tipo: string;
  destino_id: string;
  relacao: string;
  metodo: "deterministico" | "sugerido";
  confianca: number;
}

interface AlertaRisco {
  codigo: string;
  mensagem: string;
}

interface ScoreRisco {
  nivel: "ok" | "aviso" | "bloqueio";
  alertas: AlertaRisco[];
  limite_tecnico_atingido?: boolean;
  limite_tecnico_msg?: string;
}

interface DryRunResponse {
  contagem_total: number;
  amostra: ArestaVisual[];
  distribuicao_por_tipo: Record<string, number>;
  score_risco: ScoreRisco;
  regra_hash: string;
  regra_testada: {
    id: string;
    nome: string | null;
    origem_tipo: string;
    campo_origem: string;
    destino_tipo: string;
    campo_destino: string;
    combinacao: "simples" | "composta";
    sequencia: string[] | null;
  };
  config_aplicada: DryRunLimiares;
}

/** Resultado bruto da simulacao (antes de compor o score de risco). */
interface SimulacaoResultado {
  contagem_total: number;
  amostra: ArestaVisual[];
  distribuicao_por_tipo: Record<string, number>;
  confianca_min: number;
  volume_estourou: boolean;
}

// ---------------------------------------------------------------------
// Helpers de matching (espelham a logica read do backfill, sem escrita).
// ---------------------------------------------------------------------

/** Deriva o nome da relacao (aresta) da regra, igual ao backfill. */
function derivarRelacao(regra: RegraRow): string {
  if (regra.combinacao === "composta") {
    const seq = Array.isArray(regra.sequencia) && regra.sequencia.length > 0
      ? regra.sequencia.join("_")
      : regra.campo_destino;
    return `match_${seq}`;
  }
  return `match_${regra.campo_destino}`;
}

/** Resultado vazio (regra que nao gera arestas). */
function simulacaoVazia(): SimulacaoResultado {
  return {
    contagem_total: 0,
    amostra: [],
    distribuicao_por_tipo: {},
    confianca_min: 1,
    volume_estourou: false,
  };
}

/**
 * Simula a aplicacao da regra SEM persistir: le a tabela-fonte, agrupa por
 * tupla dos campos de matching e projeta as arestas (par a par, nos dois
 * sentidos - grafo nao-direcionado, identico ao backfill). Calcula a
 * contagem projetada analiticamente (Σ k*(k-1)) para nao materializar
 * arestas em excesso; materializa apenas a amostra (ate AMOSTRA_MAX).
 */
async function simularRegra(
  db: ServiceClient,
  regra: RegraRow,
  tabelasFonte: Map<string, string>,
): Promise<SimulacaoResultado> {
  // Allowlist da config (mesma fonte de verdade do backfill: config_tipos_no).
  if (!tabelasFonte.has(regra.origem_tipo)) return simulacaoVazia();
  if (!tabelasFonte.has(regra.destino_tipo)) return simulacaoVazia();

  // Escopo atual do backfill: apenas self-join (origem_tipo === destino_tipo).
  // Match entre tipos distintos ainda nao gera arestas -> simulacao 0.
  if (regra.origem_tipo !== regra.destino_tipo) return simulacaoVazia();

  const tabela = tabelasFonte.get(regra.origem_tipo) ?? null;
  if (!tabela) return simulacaoVazia();

  const relacao = derivarRelacao(regra);
  const campos: string[] = regra.combinacao === "composta"
    ? (Array.isArray(regra.sequencia) && regra.sequencia.length > 0
      ? regra.sequencia
      : [regra.campo_destino])
    : [regra.campo_destino];

  // Decompoe cada campo em coluna fisica + caminho jsonb (mesma convencao do
  // backfill): "payload_bruto.uasg" le a coluna jsonb `payload_bruto` e extrai
  // a chave `uasg` em memoria. Sempre selecionamos SO colunas fisicas.
  const camposParsed = campos.map(parseCampo);
  const colunas = colunasSelect(camposParsed);

  // O nome da tabela e as colunas sao dinamicos (definidos pela regra); o
  // PostgREST nao infere o schema. Cast controlado via any apenas no builder.
  // deno-lint-ignore no-explicit-any
  let query: any = db.from(tabela).select(`id, ${colunas.join(", ")}`);
  for (const campo of camposParsed) {
    // Filtro .not so em coluna fisica escalar; jsonb aninhado e tratado na
    // extracao (tupla null = campo vazio -> registro ignorado).
    if (!ehJsonPath(campo)) query = query.not(campo.coluna, "is", null);
  }
  const { data: registros, error: selErr } = await query;
  if (selErr) {
    // Coluna fisica inexistente (Postgres 42703 / PostgREST 42703) e ERRO DE
    // CONFIGURACAO da regra, nao falha de servidor: devolve 422 legivel em vez
    // de 500 cru (o campo aponta pra coluna que nao existe na tabela-fonte).
    const codigo = (selErr as { code?: string }).code ?? "";
    if (codigo === "42703" || /does not exist/i.test(selErr.message)) {
      throw new HttpError(
        422,
        "campo_inexistente",
        `a regra referencia um campo que nao existe em ${tabela}: ${selErr.message}`,
      );
    }
    throw new HttpError(
      500,
      "dry_run_query_failed",
      `falha ao simular a regra sobre ${tabela}: ${selErr.message}`,
    );
  }
  const lista = (registros ?? []) as unknown as Array<Record<string, unknown>>;

  // Agrupa por tupla dos campos (ja resolvidos do jsonb). Tupla null =
  // algum campo vazio -> registro ignorado.
  const grupos = new Map<string, string[]>();
  for (const r of lista) {
    const tupla = extrairTupla(r, camposParsed);
    if (tupla === null) continue;
    const chave = tupla.join("|");
    const arr = grupos.get(chave) ?? [];
    arr.push(String(r.id));
    grupos.set(chave, arr);
  }

  // Contagem projetada analitica: cada grupo de k itens gera k*(k-1) arestas
  // direcionadas (par nao-ordenado k*(k-1)/2 x 2 sentidos).
  let contagem = 0;
  for (const [, ids] of grupos) {
    const k = ids.length;
    if (k < 2) continue;
    contagem += k * (k - 1);
  }

  const volumeEstourou = contagem > VOLUME_LIMITE;

  // Amostra materializada ate o teto (nao materializa alem do necessario).
  const amostra: ArestaVisual[] = [];
  outer:
  for (const [, ids] of grupos) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        amostra.push({
          origem_tipo: regra.origem_tipo,
          origem_id: ids[i],
          destino_tipo: regra.destino_tipo,
          destino_id: ids[j],
          relacao,
          metodo: "deterministico",
          confianca: 1,
        });
        if (amostra.length >= AMOSTRA_MAX) break outer;
      }
    }
  }

  const distribuicao: Record<string, number> = {};
  if (contagem > 0) {
    distribuicao[`${regra.origem_tipo}->${regra.destino_tipo}`] = contagem;
  }

  return {
    contagem_total: contagem,
    amostra,
    distribuicao_por_tipo: distribuicao,
    // Arestas deterministicas nascem com confianca 1.0.
    confianca_min: 1,
    volume_estourou: volumeEstourou,
  };
}

/**
 * Conta as arestas JA existentes atribuidas a esta regra (chave de
 * proveniencia `regra_macro:<id>`), para estimar a duplicidade sem
 * materializar o produto cartesiano. Leitura pura (head count).
 */
async function contarExistentesDaRegra(
  db: ServiceClient,
  regraId: string,
): Promise<number> {
  const { count, error } = await db
    .from("relacoes")
    .select("id", { count: "exact", head: true })
    .eq("chave", `regra_macro:${regraId}`);
  if (error) {
    // Duplicidade e um alerta SOFT best-effort: falha na contagem nao
    // derruba o dry-run; assume 0 (sem alerta de duplicidade).
    console.warn(`[${FUNCTION_SEGMENT}] contagem de existentes falhou:`, error.message);
    return 0;
  }
  return count ?? 0;
}

/** Compoe o score_risco a partir da simulacao, existentes e limiares. */
function comporScoreRisco(
  sim: SimulacaoResultado,
  existentes: number,
  regra: RegraRow,
  limiares: DryRunLimiares,
): ScoreRisco {
  const alertas: AlertaRisco[] = [];

  // SOFT: confianca baixa (arestas com confianca abaixo do limiar).
  if (sim.contagem_total > 0 && sim.confianca_min < limiares.confianca_baixa) {
    alertas.push({
      codigo: "confianca_baixa",
      mensagem:
        `arestas com confianca abaixo de ${limiares.confianca_baixa} (minima: ${sim.confianca_min})`,
    });
  }

  // SOFT: cardinalidade alta.
  if (sim.contagem_total > limiares.cardinalidade_alta) {
    alertas.push({
      codigo: "cardinalidade_alta",
      mensagem:
        `a regra projeta ${sim.contagem_total} arestas (acima de ${limiares.cardinalidade_alta})`,
    });
  }

  // SOFT: duplicidade (fracao ja existente atribuida a esta regra).
  const duplicidadePct = sim.contagem_total > 0 ? Math.min(1, existentes / sim.contagem_total) : 0;
  if (duplicidadePct > limiares.duplicidade_pct) {
    const pct = Math.round(duplicidadePct * 100);
    alertas.push({
      codigo: "duplicidade",
      mensagem: `~${pct}% das arestas ja existem para esta regra (acima de ${
        Math.round(limiares.duplicidade_pct * 100)
      }%)`,
    });
  }

  // SOFT: origem = destino (regra conecta o mesmo tipo a si mesmo).
  if (regra.origem_tipo === regra.destino_tipo) {
    alertas.push({
      codigo: "origem_igual_destino",
      mensagem: `a regra conecta nos do mesmo tipo (${regra.origem_tipo})`,
    });
  }

  // SOFT: amostra insuficiente (poucas arestas para avaliar).
  if (sim.contagem_total < limiares.amostra_insuficiente) {
    alertas.push({
      codigo: "amostra_insuficiente",
      mensagem:
        `apenas ${sim.contagem_total} arestas projetadas (abaixo de ${limiares.amostra_insuficiente})`,
    });
  }

  // DURO: limite tecnico de volume (nunca configuravel).
  if (sim.volume_estourou) {
    return {
      nivel: "bloqueio",
      alertas,
      limite_tecnico_atingido: true,
      limite_tecnico_msg:
        `volume projetado (${sim.contagem_total}) excede o limite tecnico de ${VOLUME_LIMITE}`,
    };
  }

  return {
    nivel: alertas.length > 0 ? "aviso" : "ok",
    alertas,
  };
}

/** Le os limiares SOFT da org (fallback para os defaults). */
async function carregarLimiares(
  db: ServiceClient,
  orgId: string,
): Promise<DryRunLimiares> {
  const { data, error } = await db
    .from("config_relacionamentos")
    .select("dry_run_limiares")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar limiares do dry-run");
  }
  const raw = (data as { dry_run_limiares: Partial<DryRunLimiares> | null } | null)
    ?.dry_run_limiares;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LIMIARES };
  // Merge com defaults: chaves ausentes/invalidas caem no default.
  return {
    confianca_baixa: numeroOuDefault(raw.confianca_baixa, DEFAULT_LIMIARES.confianca_baixa),
    cardinalidade_alta: numeroOuDefault(
      raw.cardinalidade_alta,
      DEFAULT_LIMIARES.cardinalidade_alta,
    ),
    duplicidade_pct: numeroOuDefault(raw.duplicidade_pct, DEFAULT_LIMIARES.duplicidade_pct),
    amostra_insuficiente: numeroOuDefault(
      raw.amostra_insuficiente,
      DEFAULT_LIMIARES.amostra_insuficiente,
    ),
  };
}

function numeroOuDefault(valor: unknown, fallback: number): number {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : fallback;
}

/** Carrega a regra do catalogo escopada por org. 404 se inexistente. */
async function carregarRegra(
  db: ServiceClient,
  regraId: string,
  orgId: string,
): Promise<RegraRow> {
  const { data, error } = await db
    .from("catalogo_regras_vinculo")
    .select(
      "id, org_id, nome, origem_tipo, campo_origem, destino_tipo, campo_destino, combinacao, sequencia",
    )
    .eq("id", regraId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "catalogo_regras_query_failed", "falha ao consultar a regra");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "regra nao encontrada");
  }
  return data as RegraRow;
}

/** Aplica o timeout DURO de 30s; estouro => HttpError 408. */
function comTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new HttpError(
          408,
          "dry_run_timeout",
          `dry-run excedeu o tempo limite de ${Math.round(ms / 1000)}s`,
          { limite_tecnico_atingido: true },
        ),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    const { email, user } = await requireAuthorizedUser(req);

    const db = createServiceClient();
    const orgId = await resolverOrgIdUsuario(db, user.id);

    const input = await parseJsonBody(req, relacionamentosDryRunSchema);

    // Carrega a regra ATUAL e computa o hash dos campos de matching (E9).
    const regra = await carregarRegra(db, input.regra_id, orgId);
    const regraHash = hashRegraMatching(regra);

    // Single-flight por (usuario, regra, hash): disparos concorrentes
    // identicos reaproveitam a MESMA simulacao (E14).
    const chaveCoalesce = `${user.id}:${regra.id}:${regraHash}`;
    const resposta = await coalesce<DryRunResponse>(chaveCoalesce, async () => {
      const [limiares, tabelasFonte] = await Promise.all([
        carregarLimiares(db, orgId),
        carregarTabelasFonte(db, orgId),
      ]);

      // Simulacao + duplicidade sob timeout DURO de 30s.
      const [sim, existentes] = await comTimeout(
        Promise.all([
          simularRegra(db, regra, tabelasFonte),
          contarExistentesDaRegra(db, regra.id),
        ]),
        TIMEOUT_MS,
      );

      const scoreRisco = comporScoreRisco(sim, existentes, regra, limiares);

      return {
        contagem_total: sim.contagem_total,
        amostra: sim.amostra,
        distribuicao_por_tipo: sim.distribuicao_por_tipo,
        score_risco: scoreRisco,
        regra_hash: regraHash,
        regra_testada: {
          id: regra.id,
          nome: regra.nome,
          origem_tipo: regra.origem_tipo,
          campo_origem: regra.campo_origem,
          destino_tipo: regra.destino_tipo,
          campo_destino: regra.campo_destino,
          combinacao: regra.combinacao,
          sequencia: regra.sequencia,
        },
        config_aplicada: limiares,
      };
    });

    // Auditoria (simulacao de mutacao). Best-effort - nunca derruba o fluxo.
    await logSensitiveAction({
      tabela: "catalogo_regras_vinculo",
      acao: "relacionamento_dry_run",
      registroId: regra.id,
      usuario: email,
      dadosNovos: {
        regra_hash: regraHash,
        contagem_total: resposta.contagem_total,
        score_risco_nivel: resposta.score_risco.nivel,
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
