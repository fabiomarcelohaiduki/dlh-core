// =====================================================================
// Edge Function: nomus-ingerir  ->  POST /nomus/ingerir
// Endpoint de PUSH do coletor de NUVEM (GitHub Actions / runner Node).
//
//   MOTIVO (decisao 2026-06-07): o Nomus (famaha.nomus.com.br) so aceita TLS
//   1.2 com cifra CBC legada (ECDHE-RSA-AES256-SHA384). O Deno (runtime do
//   Supabase Edge, rustls) removeu todas as cifras CBC -> handshake failure.
//   Logo, a COLETA do Nomus NAO roda no Edge. Um runner Node (OpenSSL) na
//   nuvem pagina o Nomus e faz PUSH dos processos BRUTOS para esta funcao,
//   que reaproveita o pipeline de persistencia/indexacao do cockpit
//   (mapRawProcesso + persistAndIndexRecord): dedup por nomus_id, decisao de
//   reindexacao por hash, registro de execucao e contadores no cockpit.
//
//   ENVIO EM LOTES (1 execucao por ciclo): o Edge tem orcamento de CPU/memoria
//   limitado, entao o runner fragmenta os processos em lotes pequenos. O 1o
//   lote (sem execucao_id) cria a execucao e a deixa 'em_andamento'; os lotes
//   seguintes referenciam execucao_id e acumulam contadores; o lote final
//   (final:true) finaliza 'concluida' e marca fontes.ultima_coleta_em. Se o
//   runner falhar no meio, ele chama { execucao_id, abort:true } para deixar a
//   execucao em 'erro' e nao travar o single-flight global.
//
//   - Autentica por chamada interna (mesmo padrao do orquestrador): Bearer
//     service_role OU segredo de sistema do Vault no header X-Cron-Secret.
//   - SINGLE-FLIGHT GLOBAL: o 1o lote recusa (409) se ja houver execucao
//     'em_andamento' (US-04). Lotes de continuacao nao re-checam.
//   - Falha isolada por item vira linha em erros_ingestao e o lote CONTINUA
//     (RNF-05); nunca grava payload em mensagem de erro (SEC-09).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { getFonteByTipo, getServiceSecret } from "../_shared/vault.ts";
import { mapRawPessoa, mapRawProcesso, type NomusRecursoConfig } from "../_shared/nomus-connector.ts";
import type { CollectedPessoa, CollectedRecord } from "../_shared/collected.ts";
import { resolveEmbeddingProvider } from "../_shared/indexacao.ts";
import {
  persistAndIndexPessoa,
  persistAndIndexRecord,
  type PersistContext,
  processoOrigemFina,
} from "../_shared/nomus-pipeline.ts";
import { errorMessage, recordIngestErro } from "../_shared/ingest-errors.ts";

const CRON_SECRET_NAME = "CRON_DISPATCH_SECRET" as const;
const DEFAULT_RECURSO = "processos" as const;

type ServiceClient = ReturnType<typeof createServiceClient>;

interface IngerirInput {
  action?: string;
  gatilho?: string;
  recurso?: string;
  processos: unknown[];
  execucaoId?: string;
  final?: boolean;
  abort?: boolean;
  /**
   * Modo EFETIVO da coleta deste runner ('full' | 'incremental'), gravado no
   * checkpoint p/ a coluna JANELA distinguir varredura completa de incremental.
   * full = varreu todas as paginas (backfill / banco vazio); incremental = so
   * novos por id (+ modificados de pessoas). Ausente em execucoes legadas.
   */
  modo?: "full" | "incremental";
  /** Pagina (1-indexed) deste lote no backfill — base do cursor de retomada. */
  pagina?: number;
  /**
   * Tempo total decorrido no runner (ms), enviado SO no lote final. Fonte da
   * `duracao` da execucao: como a execucao nasce no 1o push (lazy), fim-inicio
   * do banco subconta o tempo que o runner gastou lendo o Nomus antes de empurrar.
   */
  duracaoMs?: number;
}

/**
 * Janela de frescor do cursor do runner. Se o ultimo lote (checkpoint.runner_ts)
 * chegou ha menos que isto, ha um run ATIVO de verdade (nao mexer). Se chegou
 * ha mais, a execucao e ORFA (run morto por timeout/cancel) e pode ser abortada
 * e retomada. Cada pagina do backfill leva ~70s; 15 min cobre folga de ~12 pag.
 */
const RUNNER_STALE_MS = 15 * 60_000;

interface IngerirResponse {
  execucao_id: string | null;
  estado: "concluida" | "em_andamento" | "erro";
  recurso: string;
  recebidos: number;
  novos: number;
  alterados: number;
  ignorados: number;
  erros: number;
  ja_em_andamento?: boolean;
}

// ---------------------------------------------------------------------
// Autenticacao da chamada interna (service_role OU X-Cron-Secret no Vault)
// ---------------------------------------------------------------------

async function assertInternalAuth(req: Request): Promise<void> {
  const bearer = extractBearerToken(req);
  const env = getEnv();
  if (bearer && timingSafeEqual(bearer, env.serviceRoleKey)) return;

  const provided = req.headers.get("X-Cron-Secret")?.trim() ?? "";
  const expected = (await getServiceSecret(CRON_SECRET_NAME))?.trim() ?? "";
  if (expected && provided && timingSafeEqual(provided, expected)) return;

  throw new HttpError(401, "cron_unauthorized", "chamada interna nao autorizada");
}

// ---------------------------------------------------------------------
// Parse do corpo
// ---------------------------------------------------------------------

async function parseInput(req: Request): Promise<IngerirInput> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "corpo_invalido", "corpo da requisicao nao e JSON valido");
  }
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "corpo_invalido", "corpo da requisicao ausente");
  }
  const o = body as Record<string, unknown>;
  const action = typeof o.action === "string" ? o.action : undefined;
  const abort = o.abort === true;
  const execucaoId = typeof o.execucao_id === "string" ? o.execucao_id : undefined;
  const modo = o.modo === "full" || o.modo === "incremental" ? o.modo : undefined;
  const paginaRaw = typeof o.pagina === "number" ? o.pagina : NaN;
  const duracaoRaw = typeof o.duracao_ms === "number" ? o.duracao_ms : NaN;

  // No abort/action, 'processos' nao e exigido (acoes read-only ou de controle).
  if (!abort && !action && !Array.isArray(o.processos)) {
    throw new HttpError(422, "processos_ausentes", "campo 'processos' (array) e obrigatorio");
  }
  return {
    action,
    gatilho: typeof o.gatilho === "string" ? o.gatilho : undefined,
    recurso: typeof o.recurso === "string" ? o.recurso : undefined,
    processos: Array.isArray(o.processos) ? o.processos : [],
    execucaoId,
    modo,
    final: o.final === true,
    abort,
    pagina: Number.isFinite(paginaRaw) && paginaRaw >= 1 ? Math.floor(paginaRaw) : undefined,
    duracaoMs: Number.isFinite(duracaoRaw) && duracaoRaw >= 0 ? Math.floor(duracaoRaw) : undefined,
  };
}

// ---------------------------------------------------------------------
// Config do recurso (recursos.<recurso>) — allowlist de tipos
// ---------------------------------------------------------------------

async function loadTiposAtivos(
  service: ServiceClient,
  fonteId: string,
  recurso: string,
): Promise<string[]> {
  const { data, error } = await service
    .from("config_ingestao")
    .select("recursos")
    .eq("fonte_id", fonteId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar a config de ingestao");
  }
  const recursos = (data as { recursos: Record<string, unknown> | null } | null)?.recursos ?? null;
  const raw = recursos?.[recurso];
  if (!raw || typeof raw !== "object") return [];
  const cfg = raw as NomusRecursoConfig;
  // Master switch do recurso: ativo===false desliga a coleta do modulo
  // (lista vazia => o pipeline ignora tudo). Defesa em profundidade — vale
  // tanto para o disparo manual quanto para qualquer cron que dispare. ativo
  // ausente/true segue o comportamento legado (coleta pela allowlist de tipos).
  if (cfg.ativo === false) return [];
  return Array.isArray(cfg.tipos_ativos)
    ? cfg.tipos_ativos.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Master switch dos recursos SEM allowlist de tipos (ex.: pessoas — o papel
 * vem das `categorias`, nao de um `tipo`). Retorna false quando a config do
 * recurso esta ausente ou `ativo===false`; qualquer outro caso (ativo true ou
 * ausente DENTRO de um recurso ja seedado) segue ligado. A migration seeda
 * `recursos.pessoas = {ativo:true}`, entao ausencia TOTAL = recurso desligado.
 */
async function loadRecursoAtivo(
  service: ServiceClient,
  fonteId: string,
  recurso: string,
): Promise<boolean> {
  const { data, error } = await service
    .from("config_ingestao")
    .select("recursos")
    .eq("fonte_id", fonteId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar a config de ingestao");
  }
  const recursos = (data as { recursos: Record<string, unknown> | null } | null)?.recursos ?? null;
  const raw = recursos?.[recurso];
  if (!raw || typeof raw !== "object") return false;
  return (raw as NomusRecursoConfig).ativo !== false;
}

/**
 * Marca d'agua (high-water mark) da coleta: maior nomus_id ja persistido,
 * comparado NUMERICAMENTE (a coluna e TEXT, entao MAX lexicografico erraria).
 * Delega para a funcao SQL public.nomus_max_nomus_id(). Retorna null quando o
 * banco ainda nao tem nenhum processo (coletor cai em varredura completa).
 */
async function loadWatermark(service: ServiceClient): Promise<number | null> {
  const { data, error } = await service.rpc("nomus_max_nomus_id");
  if (error) {
    throw new HttpError(500, "watermark_query_failed", "falha ao consultar a marca d'agua");
  }
  if (data === null || data === undefined) return null;
  const n = Number(data);
  return Number.isFinite(n) ? n : null;
}

/** Marca d'agua do recurso `pessoas`: maior nomus_id de nomus_pessoas. */
async function loadWatermarkPessoa(service: ServiceClient): Promise<number | null> {
  const { data, error } = await service.rpc("nomus_max_pessoa_id");
  if (error) {
    throw new HttpError(500, "watermark_query_failed", "falha ao consultar a marca d'agua");
  }
  if (data === null || data === undefined) return null;
  const n = Number(data);
  return Number.isFinite(n) ? n : null;
}

/**
 * Marca d'agua POR DATA do recurso `pessoas`: maior data_modificacao ja
 * persistida (ISO com timezone, ex.: '2026-06-11T12:56:29-03:00'). O coletor
 * de nuvem usa isto para a 2a passada do incremental — pegar EDICOES de
 * pessoas antigas via filtro RSQL server-side (?query=dataModificacao>...),
 * que o corte por nomus_id sozinho nunca alcanca. Retorna null quando ainda
 * nao ha nenhuma pessoa com data_modificacao (coletor pula a 2a passada).
 */
async function loadWatermarkDataPessoa(service: ServiceClient): Promise<string | null> {
  const { data, error } = await service
    .from("nomus_pessoas")
    .select("data_modificacao")
    .not("data_modificacao", "is", null)
    .order("data_modificacao", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "watermark_query_failed", "falha ao consultar a marca d'agua por data");
  }
  const v = (data as { data_modificacao: string | null } | null)?.data_modificacao ?? null;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Janela (floor) POR RECURSO: corte de partida independente por modulo. */
interface RecursoFloor {
  /** Corte por nomus_id (modulos sequenciais por id, ex.: processos>=25000). */
  idInicial: number | null;
  /** Corte por data de criacao 'YYYY-MM-DD' (>= data). */
  dataInicial: string | null;
  /** Janela deslizante em dias (full): registrada na execucao p/ a coluna JANELA. */
  janelaDias: number | null;
}

/** Data de hoje (UTC) menos N dias, 'YYYY-MM-DD'. Base da janela DESLIZANTE. */
function isoDateMinusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Janela do cockpit POR RECURSO (config_ingestao.recursos.<recurso>):
 * id_inicial corta por nomus_id e data_inicial por data de criacao. O Nomus
 * nao filtra server-side; este e o corte na borda. Quando o recurso nao define
 * janela propria, cai no data_inicial GLOBAL (top-level) por retrocompat.
 */
async function loadFloor(
  service: ServiceClient,
  fonteId: string,
  recurso: string,
): Promise<RecursoFloor> {
  const { data, error } = await service
    .from("config_ingestao")
    .select("data_inicial, recursos")
    .eq("fonte_id", fonteId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar a config de ingestao");
  }
  const row = data as
    | { data_inicial: string | null; recursos: Record<string, unknown> | null }
    | null;
  const topRaw = row?.data_inicial ?? null;
  const topData = typeof topRaw === "string" && topRaw.length >= 10 ? topRaw.slice(0, 10) : null;

  const rc = (row?.recursos?.[recurso] ?? null) as Record<string, unknown> | null;
  const idRaw = rc?.["id_inicial"];
  const idInicial = typeof idRaw === "number" && Number.isFinite(idRaw) ? Math.floor(idRaw) : null;
  const dataRaw = rc?.["data_inicial"];
  const recData = typeof dataRaw === "string" && dataRaw.length >= 10 ? dataRaw.slice(0, 10) : null;

  // Janela DESLIZANTE (full): janela_dias > 0 => corte = hoje - janela_dias,
  // recalculado a cada chamada. Limita o full ao historico recente (ex.: 3 anos)
  // e nao cresce com o tempo. Tem prioridade sobre data_inicial fixo (legado).
  const janelaRaw = rc?.["janela_dias"];
  const janelaDias =
    typeof janelaRaw === "number" && Number.isFinite(janelaRaw) && janelaRaw > 0
      ? Math.floor(janelaRaw)
      : null;
  const slidingData = janelaDias !== null ? isoDateMinusDays(janelaDias) : null;

  // Prioridade: janela deslizante > data_inicial fixo do recurso > top-level legado.
  return { idInicial, dataInicial: slidingData ?? recData ?? topData, janelaDias };
}

interface ExecCounters {
  inicioMs: number;
  novos: number;
  alterados: number;
  sucesso: number;
  erro: number;
  total: number;
}

async function loadExecCounters(service: ServiceClient, execucaoId: string): Promise<ExecCounters> {
  const { data, error } = await service
    .from("execucoes")
    .select(
      "inicio, novos, alterados, processados_sucesso, processados_erro, total_processar, status",
    )
    .eq("id", execucaoId)
    .maybeSingle();
  if (error || !data) {
    throw new HttpError(404, "execucao_nao_encontrada", "execucao informada nao existe");
  }
  const row = data as {
    inicio?: string | null;
    novos?: number | null;
    alterados?: number | null;
    processados_sucesso?: number | null;
    processados_erro?: number | null;
    total_processar?: number | null;
    status?: string | null;
  };
  if (row.status !== "em_andamento") {
    throw new HttpError(409, "execucao_nao_em_andamento", "execucao nao esta em andamento");
  }
  const inicioMs = row.inicio ? Date.parse(row.inicio) : Date.now();
  return {
    inicioMs: Number.isFinite(inicioMs) ? inicioMs : Date.now(),
    novos: row.novos ?? 0,
    alterados: row.alterados ?? 0,
    sucesso: row.processados_sucesso ?? 0,
    erro: row.processados_erro ?? 0,
    total: row.total_processar ?? 0,
  };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    await assertInternalAuth(req);

    const input = await parseInput(req);
    const recurso = input.recurso ?? DEFAULT_RECURSO;
    const service = createServiceClient();

    // -----------------------------------------------------------------
    // WATERMARK (read-only): devolve o maior nomus_id ja persistido para o
    // coletor de nuvem cortar a coleta em processos NOVOS (id > marca), sem
    // varrer todas as paginas. Nao toca execucoes nem fonte.
    // -----------------------------------------------------------------
    if (input.action === "watermark") {
      if (recurso === "pessoas") {
        const [max, maxData] = await Promise.all([
          loadWatermarkPessoa(service),
          loadWatermarkDataPessoa(service),
        ]);
        // max_data_modificacao habilita a 2a passada (modificados) no runner.
        return jsonResponse({ max_nomus_id: max, max_data_modificacao: maxData }, 200);
      }
      const max = await loadWatermark(service);
      return jsonResponse({ max_nomus_id: max }, 200);
    }

    // -----------------------------------------------------------------
    // RETOMAR (cursor de backfill): o runner pergunta de qual pagina
    // comecar antes de coletar. Decide entre iniciar do zero, retomar uma
    // execucao ORFA (run morto por timeout 6h / cancel) ou recusar quando
    // ha um run ATIVO em paralelo:
    //   - sem execucao em_andamento -> { desde_pagina: 1 }
    //   - em_andamento com runner_ts FRESCO -> 409 { ja_ativo: true }
    //   - em_andamento ORFA (runner_ts velho/ausente) -> aborta (status
    //     'erro') e devolve { desde_pagina: (runner_pagina ?? 0) + 1 }.
    // O checkpoint usa { runner_pagina, runner_ts } DE PROPOSITO sem
    // pagina_atual/janela_inicio: assim parseCheckpoint() do orquestrador
    // pg_cron retorna null e NAO tenta avancar a execucao pelo Edge (que
    // nao conecta no Nomus por TLS legado).
    // -----------------------------------------------------------------
    if (input.action === "retomar") {
      const { data: rows, error: retErr } = await service
        .from("execucoes")
        .select("id, checkpoint")
        .eq("status", "em_andamento")
        .eq("recurso", recurso)
        .order("inicio", { ascending: false })
        .limit(1);
      if (retErr) {
        throw new HttpError(
          500,
          "execucao_query_failed",
          "falha ao verificar execucoes em andamento",
        );
      }
      if (!rows || rows.length === 0) {
        return jsonResponse({ desde_pagina: 1, retomar: false }, 200);
      }
      const row = rows[0] as { id: string; checkpoint: unknown };
      const cp = row.checkpoint && typeof row.checkpoint === "object"
        ? row.checkpoint as Record<string, unknown>
        : {};
      const runnerTs = typeof cp.runner_ts === "string" ? Date.parse(cp.runner_ts) : NaN;
      const idadeMs = Number.isFinite(runnerTs) ? Date.now() - runnerTs : Infinity;
      if (idadeMs < RUNNER_STALE_MS) {
        // Lote recente: ha um run ATIVO de verdade. Nao pisar.
        return jsonResponse({ ja_ativo: true, execucao_id: String(row.id) }, 409);
      }
      // Orfa: libera o single-flight (abort) e manda retomar da proxima pagina.
      await service
        .from("execucoes")
        .update({ status: "erro", etapa_atual: null, fim: new Date().toISOString() })
        .eq("id", row.id)
        .eq("status", "em_andamento");
      const runnerPagina = typeof cp.runner_pagina === "number" ? Math.floor(cp.runner_pagina) : 0;
      return jsonResponse({
        desde_pagina: Math.max(1, runnerPagina + 1),
        retomar: true,
        execucao_anterior: String(row.id),
      }, 200);
    }

    const fonte = await getFonteByTipo("nomus");

    // -----------------------------------------------------------------
    // JANELA (read-only): devolve a data de corte deslizante (hoje -
    // janela_dias) ja resolvida pelo loadFloor. O runner FULL usa para PARAR a
    // varredura ao cruzar o corte (espelha o "alcancou a marca" do incremental).
    // null = sem janela configurada (varre tudo).
    // -----------------------------------------------------------------
    if (input.action === "janela") {
      const floor = await loadFloor(service, fonte.id, recurso);
      return jsonResponse({ data_corte: floor.dataInicial }, 200);
    }

    // -----------------------------------------------------------------
    // ABORT: deixa a execucao em 'erro' (libera o single-flight global).
    // -----------------------------------------------------------------
    if (input.abort) {
      if (!input.execucaoId) {
        throw new HttpError(422, "execucao_ausente", "abort exige execucao_id");
      }
      await service
        .from("execucoes")
        .update({ status: "erro", etapa_atual: null, fim: new Date().toISOString() })
        .eq("id", input.execucaoId)
        .eq("status", "em_andamento");
      const body: IngerirResponse = {
        execucao_id: input.execucaoId,
        estado: "erro",
        recurso,
        recebidos: 0,
        novos: 0,
        alterados: 0,
        ignorados: 0,
        erros: 0,
      };
      return jsonResponse(body, 200);
    }

    // Janela do recurso (corte + janela deslizante). Carregada aqui para que a
    // criacao da execucao registre `janela_dias` (coluna JANELA das telas).
    const floor = await loadFloor(service, fonte.id, recurso);

    // Periodo coletado (de–ate) p/ a coluna JANELA do cockpit, no mesmo formato
    // do Effecti (limites no checkpoint jsonb). Inferior = corte do floor (janela
    // deslizante de processos / data_inicial); superior = agora. Vai no checkpoint
    // SEM `pagina_atual`, entao parseCheckpoint() do orquestrador pg_cron segue
    // retornando null (so retoma com pagina_atual+janela_inicio) e o bloco
    // "retomar" so le runner_ts/runner_pagina -> retomada inalterada. Recurso sem
    // floor (ex.: pessoas = varre tudo) fica null -> a coluna JANELA exibe "completa".
    const periodoNomus = floor.dataInicial
      ? {
        janela_inicio: `${floor.dataInicial}T00:00:00.000Z`,
        janela_fim: new Date().toISOString(),
      }
      : null;

    // Base do checkpoint comum ao insert e ao update: periodo da janela (quando ha
    // floor) + o modo EFETIVO do runner ('full' | 'incremental'), p/ a coluna JANELA
    // distinguir varredura completa de incremental mesmo quando o recurso nao tem
    // janela (pessoas). Continua SEM `pagina_atual` -> parseCheckpoint() do
    // orquestrador pg_cron segue null (nao avanca pelo Edge). Vazio -> sem checkpoint.
    const checkpointBase: Record<string, unknown> = {
      ...(periodoNomus ?? {}),
      ...(input.modo ? { modo: input.modo } : {}),
    };
    const temCheckpointBase = Object.keys(checkpointBase).length > 0;

    // Resolve o provider de embeddings ANTES de criar a execucao em_andamento:
    // se a chave OpenAI faltar no Vault, falha (503) sem deixar execucao orfa
    // travando o single-flight do recurso.
    const embeddingProvider = await resolveEmbeddingProvider();

    // -----------------------------------------------------------------
    // Resolve a execucao: continua a existente ou cria uma nova (1o lote).
    // -----------------------------------------------------------------
    let execucaoId: string;
    let prev: ExecCounters;

    if (input.execucaoId) {
      execucaoId = input.execucaoId;
      prev = await loadExecCounters(service, execucaoId);
    } else {
      // Single-flight POR RECURSO: nao iniciar enquanto houver execucao em
      // andamento DESTE recurso desta fonte. Escopar por (fonte_id, recurso)
      // permite modulos coletarem em paralelo (ex.: processos x cobranca) e
      // que uma orfa de um modulo nao barre os demais.
      const { data: emAndamento, error: andamentoError } = await service
        .from("execucoes")
        .select("id")
        .eq("status", "em_andamento")
        .eq("fonte_id", fonte.id)
        .eq("recurso", recurso)
        .limit(1);
      if (andamentoError) {
        throw new HttpError(
          500,
          "execucao_query_failed",
          "falha ao verificar execucoes em andamento",
        );
      }
      if (emAndamento && emAndamento.length > 0) {
        const corrente = emAndamento[0] as { id: string };
        const body: IngerirResponse = {
          execucao_id: String(corrente.id),
          estado: "em_andamento",
          recurso,
          recebidos: input.processos.length,
          novos: 0,
          alterados: 0,
          ignorados: 0,
          erros: 0,
          ja_em_andamento: true,
        };
        return jsonResponse(body, 409);
      }

      const tiposIniciais = await loadTiposAtivos(service, fonte.id, recurso);
      // Cria a execucao SEM checkpoint: o orquestrador (pg_cron) trata execucoes
      // com recurso porem sem checkpoint como ociosas (nao avanca blocos).
      const { data: execucao, error: insError } = await service
        .from("execucoes")
        .insert({
          inicio: new Date().toISOString(),
          gatilho: input.gatilho ?? "agendada",
          fonte_id: fonte.id,
          recurso,
          tipo_alvo: tiposIniciais.length > 0 ? tiposIniciais.join(", ") : null,
          novos: 0,
          alterados: 0,
          status: "em_andamento",
          etapa_atual: "coleta",
          // FULL grava a janela deslizante (full envia `pagina`); incremental
          // (watermark, sem `pagina`) fica null -> coluna JANELA exibe '—'.
          janela_dias: input.pagina !== undefined ? floor.janelaDias : null,
          total_processar: 0,
          processados_sucesso: 0,
          processados_erro: 0,
          pendentes: 0,
          // Periodo da janela (de–ate) + modo (full|incremental) p/ a coluna
          // JANELA. Recurso sem floor (pessoas) nao tem periodo, mas o modo
          // ainda entra -> coluna distingue full de incremental.
          ...(temCheckpointBase ? { checkpoint: checkpointBase } : {}),
        })
        .select("id")
        .single();
      if (insError || !execucao) {
        throw new HttpError(500, "execucao_insert_failed", "falha ao criar a execucao");
      }
      execucaoId = String((execucao as { id: string }).id);
      prev = { inicioMs: Date.now(), novos: 0, alterados: 0, sucesso: 0, erro: 0, total: 0 };
    }

    // -----------------------------------------------------------------
    // Processa o LOTE recebido (trabalho limitado por invocacao).
    // -----------------------------------------------------------------
    // Recurso `pessoas` nao usa allowlist de tipos (o papel vem das categorias):
    // o master switch e o booleano `ativo` do recurso. Demais recursos seguem a
    // allowlist (loadTiposAtivos ja devolve [] quando ativo===false).
    const isPessoa = recurso === "pessoas";
    const recursoAtivo = isPessoa ? await loadRecursoAtivo(service, fonte.id, recurso) : true;
    const tiposAtivos = isPessoa ? [] : await loadTiposAtivos(service, fonte.id, recurso);
    const ctx: PersistContext = { execucaoId, recurso, tiposAtivos, embeddingProvider };

    let novos = 0;
    let alterados = 0;
    let ignorados = 0;
    let erros = 0;

    for (const raw of input.processos) {
      const record: CollectedRecord | CollectedPessoa | null = isPessoa
        ? mapRawPessoa(raw)
        : mapRawProcesso(raw);
      if (!record) {
        ignorados += 1;
        continue;
      }
      // Master switch do recurso pessoas: desligado => ignora o lote inteiro
      // (defesa em profundidade, espelha o [] de loadTiposAtivos dos processos).
      if (isPessoa && !recursoAtivo) {
        ignorados += 1;
        continue;
      }
      // Janela do recurso: corte por id_inicial (nomus_id numerico). Ids
      // nao-numericos NAO sao descartados (evita perda; dedup resolve).
      if (floor.idInicial !== null) {
        const idn = Number(record.nomus_id);
        if (Number.isFinite(idn) && idn < floor.idInicial) {
          ignorados += 1;
          continue;
        }
      }
      // Janela do recurso: corte por data de criacao (>= data_inicial). Sem
      // data de criacao legivel o registro NAO e descartado (evita perda).
      if (
        floor.dataInicial &&
        typeof record.data_criacao === "string" &&
        record.data_criacao.slice(0, 10) < floor.dataInicial
      ) {
        ignorados += 1;
        continue;
      }
      try {
        const outcome = isPessoa
          ? await persistAndIndexPessoa(service, ctx, record as CollectedPessoa)
          : await persistAndIndexRecord(service, ctx, record as CollectedRecord);
        if (outcome.acao === "ignorado") ignorados += 1;
        else if (outcome.acao === "inserido") novos += 1;
        else alterados += 1;
      } catch (err) {
        erros += 1;
        await recordIngestErro(service, {
          execucaoId,
          severidade: "media",
          etapa: "Persistencia",
          origem: isPessoa ? "pessoa" : processoOrigemFina(record as CollectedRecord),
          recurso,
          mensagem: `falha ao processar ${recurso} ${record.nomus_id}: ${errorMessage(err)}`,
        });
      }
    }

    // Contadores acumulados (somam aos lotes anteriores desta execucao).
    const accNovos = prev.novos + novos;
    const accAlterados = prev.alterados + alterados;
    const accSucesso = prev.sucesso + novos + alterados;
    const accErro = prev.erro + erros;
    const accTotal = prev.total + input.processos.length;

    if (input.final) {
      const fim = new Date();
      const { error: finError } = await service
        .from("execucoes")
        .update({
          status: "concluida",
          etapa_atual: null,
          fim: fim.toISOString(),
          // Duracao real do runner quando enviada (lote final); senao cai no
          // fim-inicio do banco (subconta, pois a execucao nasce no 1o push).
          duracao: formatDuration(
            input.duracaoMs !== undefined ? input.duracaoMs : fim.getTime() - prev.inicioMs,
          ),
          novos: accNovos,
          alterados: accAlterados,
          total_processar: accTotal,
          processados_sucesso: accSucesso,
          processados_erro: accErro,
        })
        .eq("id", execucaoId);
      if (finError) {
        console.error("[nomus-ingerir] falha ao finalizar execucao", {
          execucaoId,
          error: finError.message,
        });
      }
      // Coleta na nuvem concluida = prova de conexao com o Nomus (o runner Node
      // alcancou o ERP e paginou). Marca estado_conexao='conectada' junto da
      // ultima_coleta_em: a saude da fonte vem da ingestao real, ja que o teste
      // direto no Edge da sempre falso-negativo (TLS legado, ver fontes-testar).
      const { error: fonteError } = await service
        .from("fontes")
        .update({ ultima_coleta_em: fim.toISOString(), estado_conexao: "conectada" })
        .eq("id", fonte.id);
      if (fonteError) {
        console.error("[nomus-ingerir] falha ao atualizar fontes.ultima_coleta_em", {
          fonteId: fonte.id,
          error: fonteError.message,
        });
      }
    } else {
      // Cursor de retomada + periodo da janela. No backfill (input.pagina
      // presente) grava a pagina ja confirmada + o timestamp do lote, mesclando o
      // periodo (janela_inicio/janela_fim). Formato sem `pagina_atual` para o
      // orquestrador pg_cron ignorar (ver bloco "retomar"; parseCheckpoint exige
      // pagina_atual). No caminho incremental (sem pagina) grava so o periodo,
      // quando ha floor (recurso sem floor -> checkpoint intocado).
      const checkpointUpd = typeof input.pagina === "number"
        ? {
          checkpoint: {
            ...checkpointBase,
            runner_pagina: input.pagina,
            runner_ts: new Date().toISOString(),
          },
        }
        : temCheckpointBase
        ? { checkpoint: checkpointBase }
        : {};
      const { error: updError } = await service
        .from("execucoes")
        .update({
          novos: accNovos,
          alterados: accAlterados,
          total_processar: accTotal,
          processados_sucesso: accSucesso,
          processados_erro: accErro,
          ...checkpointUpd,
        })
        .eq("id", execucaoId);
      if (updError) {
        console.error("[nomus-ingerir] falha ao atualizar contadores", {
          execucaoId,
          error: updError.message,
        });
      }
    }

    const body: IngerirResponse = {
      execucao_id: execucaoId,
      estado: input.final ? "concluida" : "em_andamento",
      recurso,
      recebidos: input.processos.length,
      novos,
      alterados,
      ignorados,
      erros,
    };
    return jsonResponse(body, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "nomus-ingerir" });
  }
}

getEnv();

Deno.serve(handler);
