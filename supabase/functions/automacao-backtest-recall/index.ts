// =====================================================================
// Edge Function: automacao-backtest-recall  (cockpit - gate do modo sombra)
//   -> GET /automacao-backtest-recall
//
// Mede o RECALL da triagem em MODO SOMBRA, ANTES de habilitar o descarte
// fisico (interruptor config_automacao.descarte_fisico_ligado, 3.2.6) e o
// cadastro no Nomus (ONDA 2). Cruza o estado vigente da triagem (preservado em
// avisos/triagem_decisoes) contra os processos REAIS lidos do Nomus (conector
// nomus-connector, SO LEITURA) no periodo solicitado. Para os avisos que viraram
// processo real no Nomus (verdade-fundamental "deveria ser util"), calcula
// quantos a triagem NAO mandaria para a lixeira (veredito in ('util','duvida')).
// Contrato 3.2.9 (RF-26, US-16, SEC-2).
//
//   recall = preservados_pela_triagem / casados_com_aviso
//
// Operacao 100% de leitura, idempotente e SEM efeito colateral: NAO liga o
// interruptor, NAO descarta, NAO cadastra. A falha de leitura do Nomus e
// best-effort: responde 502 com recall: null (e zera as contagens), preservando
// periodo e descarte_fisico_ligado para o cockpit renderizar o estado.
//
// Autorizacao na borda (US-21, SEC-5): requireAuthorizedUser -> 401 sem sessao,
// 403 fora da allowlist. NENHUMA credencial /v1 do Lion acessa este endpoint.
// A leitura corre com service_role apos a borda autorizar (tabelas de triagem
// fora das views lia.*, SEC-3).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  BacktestNomusError,
  type BacktestPeriodo,
  runBacktestRecall,
} from "../_shared/backtest-recall.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "automacao-backtest-recall";

/** Janela default do backtest quando `desde`/`ate` nao sao informados (90 dias). */
const DEFAULT_JANELA_DIAS = 90;
const MS_PER_DAY = 86_400_000;

/** Le o estado vigente do interruptor de descarte fisico (singleton). */
async function loadDescarteFisicoLigado(db: ServiceClient): Promise<boolean> {
  const { data, error } = await db
    .from("config_automacao")
    .select("descarte_fisico_ligado")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler config_automacao: ${error.message}`);
  }
  return data?.descarte_fisico_ligado === true;
}

/**
 * Resolve a janela do backtest a partir dos query params (ISO8601 date).
 * Valores ausentes ou invalidos recaem para o default (90 dias atras .. hoje),
 * sem rejeitar a requisicao (cap, nao 400). `ate` e normalizada para o fim do
 * dia para incluir os processos criados na propria data.
 */
function resolvePeriodo(url: URL): BacktestPeriodo {
  const agora = new Date();
  const ate = parseLimite(url.searchParams.get("ate"), agora);
  // Fim do dia de `ate` (inclusivo), garantindo a verdade-fundamental do dia.
  ate.setUTCHours(23, 59, 59, 999);

  const desdeDefault = new Date(agora.getTime() - DEFAULT_JANELA_DIAS * MS_PER_DAY);
  const desde = parseLimite(url.searchParams.get("desde"), desdeDefault);
  desde.setUTCHours(0, 0, 0, 0);

  // Guarda contra inversao: se `desde` > `ate`, recai para a janela default.
  if (desde.getTime() > ate.getTime()) {
    const fallback = new Date(ate.getTime() - DEFAULT_JANELA_DIAS * MS_PER_DAY);
    fallback.setUTCHours(0, 0, 0, 0);
    return { desde: fallback, ate };
  }
  return { desde, ate };
}

/** Parseia uma data ISO8601; retorna `fallback` quando ausente/invalida. */
function parseLimite(raw: string | null, fallback: Date): Date {
  if (raw === null || raw.trim() === "") return new Date(fallback.getTime());
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : new Date(fallback.getTime());
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");

    // Autorizacao na borda: 401 sem sessao, 403 fora da allowlist. Nenhuma
    // credencial /v1 (LIA/TRIAGEM) chega aqui: so sessao humana do cockpit.
    await requireAuthorizedUser(req);

    const db = createServiceClient();
    const periodo = resolvePeriodo(new URL(req.url));

    // Estado do interruptor: sempre exposto (inclusive no caminho 502), para o
    // cockpit renderizar o gate sem uma segunda chamada.
    const descarteFisicoLigado = await loadDescarteFisicoLigado(db);
    const periodoBody = {
      desde: periodo.desde.toISOString(),
      ate: periodo.ate.toISOString(),
    };

    try {
      const resultado = await runBacktestRecall(db, periodo);
      return jsonResponse(
        {
          periodo: periodoBody,
          processos_nomus_reais: resultado.processos_nomus_reais,
          casados_com_aviso: resultado.casados_com_aviso,
          preservados_pela_triagem: resultado.preservados_pela_triagem,
          descartados_indevidamente: resultado.descartados_indevidamente,
          recall: resultado.recall,
          descarte_fisico_ligado: descarteFisicoLigado,
          amostras_falso_descarte: resultado.amostras_falso_descarte,
        },
        200,
      );
    } catch (err) {
      // Falha de leitura do Nomus e best-effort: 502 com recall null e contagens
      // zeradas, sem mascarar o periodo/interruptor. NAO escreve nada.
      if (err instanceof BacktestNomusError) {
        console.error("[automacao-backtest-recall] leitura do Nomus falhou", {
          message: err.message,
        });
        return jsonResponse(
          {
            periodo: periodoBody,
            processos_nomus_reais: 0,
            casados_com_aviso: 0,
            preservados_pela_triagem: 0,
            descartados_indevidamente: 0,
            recall: null,
            descarte_fisico_ligado: descarteFisicoLigado,
            amostras_falso_descarte: [],
          },
          502,
        );
      }
      throw err;
    }
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
