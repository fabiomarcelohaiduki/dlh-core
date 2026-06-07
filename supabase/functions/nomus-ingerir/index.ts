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
import { createServiceClient } from "../_shared/supabase.ts";
import { getFonteByTipo, getServiceSecret } from "../_shared/vault.ts";
import { mapRawProcesso, type NomusRecursoConfig } from "../_shared/nomus-connector.ts";
import { createEmbeddingProvider } from "../_shared/embeddings.ts";
import {
  persistAndIndexRecord,
  type PersistContext,
  processoOrigemFina,
} from "../_shared/nomus-pipeline.ts";
import { errorMessage, recordIngestErro } from "../_shared/ingest-errors.ts";

const CRON_SECRET_NAME = "CRON_DISPATCH_SECRET" as const;
const DEFAULT_RECURSO = "processos" as const;

type ServiceClient = ReturnType<typeof createServiceClient>;

interface IngerirInput {
  gatilho?: string;
  recurso?: string;
  processos: unknown[];
  execucaoId?: string;
  final?: boolean;
  abort?: boolean;
}

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
  if (bearer && bearer === env.serviceRoleKey) return;

  const provided = req.headers.get("X-Cron-Secret")?.trim() ?? "";
  const expected = (await getServiceSecret(CRON_SECRET_NAME))?.trim() ?? "";
  if (expected && provided && timingSafeEqual(provided, expected)) return;

  throw new HttpError(401, "cron_unauthorized", "chamada interna nao autorizada");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  const abort = o.abort === true;
  const execucaoId = typeof o.execucao_id === "string" ? o.execucao_id : undefined;

  // No abort, 'processos' nao e exigido (so finaliza a execucao em erro).
  if (!abort && !Array.isArray(o.processos)) {
    throw new HttpError(422, "processos_ausentes", "campo 'processos' (array) e obrigatorio");
  }
  return {
    gatilho: typeof o.gatilho === "string" ? o.gatilho : undefined,
    recurso: typeof o.recurso === "string" ? o.recurso : undefined,
    processos: Array.isArray(o.processos) ? o.processos : [],
    execucaoId,
    final: o.final === true,
    abort,
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
  return Array.isArray(cfg.tipos_ativos)
    ? cfg.tipos_ativos.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Janela do cockpit (config_ingestao.data_inicial): ignora processos cuja
 * data de criacao seja anterior a esta data. Retorna 'YYYY-MM-DD' ou null
 * (sem filtro). O Nomus nao filtra por data server-side; este e o corte.
 */
async function loadDataInicial(service: ServiceClient, fonteId: string): Promise<string | null> {
  const { data, error } = await service
    .from("config_ingestao")
    .select("data_inicial")
    .eq("fonte_id", fonteId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_query_failed", "falha ao consultar a config de ingestao");
  }
  const raw = (data as { data_inicial: string | null } | null)?.data_inicial ?? null;
  return typeof raw === "string" && raw.length >= 10 ? raw.slice(0, 10) : null;
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
    const fonte = await getFonteByTipo("nomus");

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

    // -----------------------------------------------------------------
    // Resolve a execucao: continua a existente ou cria uma nova (1o lote).
    // -----------------------------------------------------------------
    let execucaoId: string;
    let prev: ExecCounters;

    if (input.execucaoId) {
      execucaoId = input.execucaoId;
      prev = await loadExecCounters(service, execucaoId);
    } else {
      // Single-flight GLOBAL: nao iniciar enquanto houver execucao em andamento.
      const { data: emAndamento, error: andamentoError } = await service
        .from("execucoes")
        .select("id")
        .eq("status", "em_andamento")
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
          total_processar: 0,
          processados_sucesso: 0,
          processados_erro: 0,
          pendentes: 0,
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
    const tiposAtivos = await loadTiposAtivos(service, fonte.id, recurso);
    const dataInicial = await loadDataInicial(service, fonte.id);
    const env = getEnv();
    const embeddingProvider = env.embeddingsEndpoint ? createEmbeddingProvider() : undefined;
    const ctx: PersistContext = { execucaoId, recurso, tiposAtivos, embeddingProvider };

    let novos = 0;
    let alterados = 0;
    let ignorados = 0;
    let erros = 0;

    for (const raw of input.processos) {
      const record = mapRawProcesso(raw);
      if (!record) {
        ignorados += 1;
        continue;
      }
      // Janela do cockpit: corta processos criados antes de data_inicial.
      // Sem data de criacao legivel o registro NAO e descartado (evita perda).
      if (
        dataInicial &&
        typeof record.data_criacao === "string" &&
        record.data_criacao.slice(0, 10) < dataInicial
      ) {
        ignorados += 1;
        continue;
      }
      try {
        const outcome = await persistAndIndexRecord(service, ctx, record);
        if (outcome.acao === "ignorado") ignorados += 1;
        else if (outcome.acao === "inserido") novos += 1;
        else alterados += 1;
      } catch (err) {
        erros += 1;
        await recordIngestErro(service, {
          execucaoId,
          severidade: "media",
          etapa: "Persistencia",
          origem: processoOrigemFina(record),
          recurso,
          mensagem: `falha ao processar processo ${record.nomus_id}: ${errorMessage(err)}`,
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
          duracao: formatDuration(fim.getTime() - prev.inicioMs),
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
      const { error: fonteError } = await service
        .from("fontes")
        .update({ ultima_coleta_em: fim.toISOString() })
        .eq("id", fonte.id);
      if (fonteError) {
        console.error("[nomus-ingerir] falha ao atualizar fontes.ultima_coleta_em", {
          fonteId: fonte.id,
          error: fonteError.message,
        });
      }
    } else {
      const { error: updError } = await service
        .from("execucoes")
        .update({
          novos: accNovos,
          alterados: accAlterados,
          total_processar: accTotal,
          processados_sucesso: accSucesso,
          processados_erro: accErro,
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
