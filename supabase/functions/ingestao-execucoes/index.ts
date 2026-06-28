// =====================================================================
// Edge Function: ingestao-execucoes  ->  GET /ingestao/execucoes
// Lista execucoes ordenadas por inicio desc, com `limit` (query param).
// Exige sessao autorizada (_shared/auth.ts). Sem sessao -> 401.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import type { Execucao, ExecucaoCheckpoint } from "../_shared/types.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PAGE_SIZE = 1000;

/**
 * Chave de origem dos badges (espelha normalizeOrigem de src/lib/status.ts).
 * A `origem` crua e o `tipo` da fonte (ou null em execucoes legadas).
 */
type OrigemKey = "effecti" | "nomus" | "gmail" | "drive";

function normalizeOrigemKey(origem: string | null): OrigemKey {
  if (!origem) return "effecti";
  const o = origem.toLowerCase();
  if (o === "gmail") return "gmail";
  if (o === "drive") return "drive";
  if (o === "nomus" || o.startsWith("processo") || o.startsWith("pessoa")) return "nomus";
  return "effecti";
}

/**
 * Contagens HONESTAS sobre o universo completo de execucoes (a lista `items` e
 * so a pagina `limit`). Alimenta os badges das guias/filtros para o numero nao
 * travar no tamanho da pagina.
 */
interface ColetaContagens {
  total: number;
  porOrigem: Record<OrigemKey, number>;
  porRecurso: Record<OrigemKey, Record<string, number>>;
}

/** Normaliza `limit` da query: default 50, faixa [1, 200]. */
function parseLimit(req: Request): number {
  const raw = new URL(req.url).searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, "invalid_limit", "limit invalido: informe um inteiro >= 1");
  }
  return Math.min(parsed, MAX_LIMIT);
}

interface ExecucaoRow {
  id: string;
  inicio: string;
  fim: string | null;
  gatilho: string;
  janela_dias: number | null;
  novos: number;
  alterados: number;
  duracao: string | null;
  status: string;
  etapa_atual: string | null;
  total_processar: number | null;
  processados_sucesso: number | null;
  processados_erro: number | null;
  pendentes: number | null;
  fonte_id: string | null;
  recurso: string | null;
  tipo_alvo: string | null;
  checkpoint: unknown;
}

/**
 * Normaliza o checkpoint jsonb (snake_case) para camelCase. Retorna null para
 * o checkpoint vazio ('{}') das execucoes legadas sem cursor de paginacao.
 * Effecti e Nomus gravam pagina_atual; o Effecti tambem traz bloco_inicio.
 */
function toCheckpoint(raw: unknown): ExecucaoCheckpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).length === 0) return null;
  return {
    paginaAtual: typeof o.pagina_atual === "number" ? o.pagina_atual : null,
    fase: typeof o.fase === "string" ? o.fase : null,
    modo: typeof o.modo === "string" ? o.modo : null,
    tentativasRetomada:
      typeof o.tentativas_retomada === "number" ? o.tentativas_retomada : null,
  };
}

function toExecucao(row: ExecucaoRow, fonteTipo: Map<string, string>): Execucao {
  return {
    id: row.id,
    inicio: row.inicio,
    fim: row.fim,
    gatilho: row.gatilho,
    janelaDias: row.janela_dias,
    novos: row.novos,
    alterados: row.alterados,
    duracao: row.duracao,
    status: row.status,
    etapaAtual: row.etapa_atual,
    totalProcessar: row.total_processar,
    processadosSucesso: row.processados_sucesso,
    processadosErro: row.processados_erro,
    pendentes: row.pendentes,
    fonteId: row.fonte_id,
    origem: row.fonte_id ? fonteTipo.get(row.fonte_id) ?? null : null,
    recurso: row.recurso,
    tipoAlvo: row.tipo_alvo,
    checkpoint: toCheckpoint(row.checkpoint),
  };
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");
    const limit = parseLimit(req);
    const { db } = await requireAuthorizedUser(req);

    const { data, error } = await db
      .from("execucoes")
      .select(
        "id, inicio, fim, gatilho, janela_dias, novos, alterados, duracao, status, etapa_atual, total_processar, processados_sucesso, processados_erro, pendentes, fonte_id, recurso, tipo_alvo, checkpoint",
      )
      .order("inicio", { ascending: false })
      .limit(limit);

    if (error) {
      throw new HttpError(500, "execucoes_query_failed", "falha ao listar execucoes");
    }

    // Mapa fonte_id -> tipo ('effecti' | 'nomus') para derivar a origem da
    // execucao (poucas fontes; uma leitura barata sob o RLS do usuario).
    const fonteTipo = new Map<string, string>();
    const { data: fontesData } = await db.from("fontes").select("id, tipo");
    for (const f of (fontesData ?? []) as { id: string; tipo: string }[]) {
      fonteTipo.set(f.id, f.tipo);
    }

    const items = ((data ?? []) as ExecucaoRow[]).map((row) =>
      toExecucao(row, fonteTipo),
    );

    // Contagens do universo COMPLETO para os badges: le so fonte_id e recurso
    // de todas as execucoes (paginado por .range para passar do teto de 1000),
    // agrega por origem/recurso. Payload minimo (duas colunas curtas).
    const contagens: ColetaContagens = {
      total: 0,
      porOrigem: { effecti: 0, nomus: 0, gmail: 0, drive: 0 },
      porRecurso: { effecti: {}, nomus: {}, gmail: {}, drive: {} },
    };
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data: page, error: pageErr } = await db
        .from("execucoes")
        .select("fonte_id, recurso")
        .range(from, from + PAGE_SIZE - 1);
      if (pageErr) {
        throw new HttpError(500, "execucoes_count_failed", "falha ao contar execucoes");
      }
      const batch = (page ?? []) as { fonte_id: string | null; recurso: string | null }[];
      for (const row of batch) {
        const origem = row.fonte_id ? fonteTipo.get(row.fonte_id) ?? null : null;
        const key = normalizeOrigemKey(origem);
        contagens.total += 1;
        contagens.porOrigem[key] += 1;
        if (row.recurso) {
          const porRec = contagens.porRecurso[key];
          porRec[row.recurso] = (porRec[row.recurso] ?? 0) + 1;
        }
      }
      if (batch.length < PAGE_SIZE) break;
    }

    return jsonResponse({ items, contagens }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "ingestao-execucoes" });
  }
}

getEnv();

Deno.serve(handler);
