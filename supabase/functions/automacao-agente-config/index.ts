// =====================================================================
// Edge Function: automacao-agente-config  (cockpit - persona do subagente, E15)
//   -> GET / PUT /automacao-agente-config
//
// Le e atualiza a persona/prompt versionada do SUBAGENTE ESPECIALISTA
// (`triagem_agente_config`) que a Lia executa no Lion. Config server-side (fonte
// unica de verdade), administrada no cockpit, auditada e versionada; a persona e
// ENTREGUE pela FILA, mas o servidor NAO chama LLM. Contrato 3.2.6.2 (E15/E16).
//
//   GET -> { ativo, nome, persona_prompt, ferramentas, versao, atualizado_em }
//   PUT -> valida zod { ativo, nome, persona_prompt (nao vazio), ferramentas
//          (subconjunto das tools conhecidas) }; o trigger incrementa `versao`;
//          responde com o shape do GET (versao nova). Auditoria registra a
//          versao anterior/nova.
//
// Quando ativo = false, a config persiste e a FILA passa a OMITIR o objeto
// agente (verificavel na FILA). A persona NUNCA carrega segredo nem conteudo
// sensivel. Autorizacao na borda (US-21): requireAuthorizedUser -> 401/403.
// Escrita auditada via logSensitiveAction. Escrita com service_role (tabelas de
// triagem fora das views lia.*, SEC-3).
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "automacao-agente-config";

/**
 * Tools LOCAIS conhecidas do Lion (3.4): busca semantica de produtos,
 * recuperacao direcionada de trechos e aplicacao de regras duras. `ferramentas`
 * deve ser um SUBCONJUNTO desta lista. Espelha o seed do singleton.
 */
const FERRAMENTAS_CONHECIDAS = [
  "busca_produtos",
  "recuperar_trechos",
  "aplicar_regras_duras",
] as const;

const MAX_NOME_CHARS = 200;
const MAX_PERSONA_CHARS = 10_000;

// ---------------------------------------------------------------------
// Schema (zod) do PUT.
// ---------------------------------------------------------------------

const putBodySchema = z.object({
  ativo: z.boolean(),
  nome: z
    .string()
    .trim()
    .min(1, "nome nao pode ser vazio")
    .max(MAX_NOME_CHARS, "nome muito longo"),
  persona_prompt: z
    .string()
    .trim()
    .min(1, "persona_prompt nao pode ser vazio")
    .max(MAX_PERSONA_CHARS, "persona_prompt muito longo"),
  ferramentas: z
    .array(z.enum(FERRAMENTAS_CONHECIDAS, {
      errorMap: () => ({ message: "ferramenta desconhecida" }),
    }))
    .max(FERRAMENTAS_CONHECIDAS.length, "ferramentas excede o conjunto conhecido"),
});

type PutBody = z.infer<typeof putBodySchema>;

/** Shape de resposta (GET e PUT). */
interface AgenteConfigResponse {
  ativo: boolean;
  nome: string;
  persona_prompt: string;
  ferramentas: string[];
  versao: number;
  atualizado_em: string | null;
}

interface AgenteConfigRow {
  ativo: boolean | null;
  nome: string | null;
  persona_prompt: string | null;
  ferramentas: unknown;
  versao: number | null;
  atualizado_em: string | null;
}

const AGENTE_COLS = "ativo, nome, persona_prompt, ferramentas, versao, atualizado_em";

/** Mapeia a linha do banco para o shape de resposta. */
function toResponse(row: AgenteConfigRow): AgenteConfigResponse {
  return {
    ativo: row.ativo === true,
    nome: row.nome ?? "",
    persona_prompt: row.persona_prompt ?? "",
    ferramentas: Array.isArray(row.ferramentas)
      ? (row.ferramentas as unknown[]).map((f) => String(f))
      : [],
    versao: typeof row.versao === "number" ? row.versao : 0,
    atualizado_em: row.atualizado_em ?? null,
  };
}

/** Le o singleton (sempre existe via seed). 500 se ausente/erro. */
async function loadConfig(db: ServiceClient): Promise<AgenteConfigRow> {
  const { data, error } = await db
    .from("triagem_agente_config")
    .select(AGENTE_COLS)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler triagem_agente_config: ${error.message}`);
  }
  if (!data) {
    throw new Error("triagem_agente_config ausente (seed nao aplicado)");
  }
  // select por string em variavel quebra a inferencia do PostgREST -> cast.
  return data as unknown as AgenteConfigRow;
}

// ---------------------------------------------------------------------
// GET: retorna a persona versionada (sem segredos).
// ---------------------------------------------------------------------

async function handleGet(db: ServiceClient): Promise<Response> {
  const row = await loadConfig(db);
  return jsonResponse(toResponse(row), 200);
}

// ---------------------------------------------------------------------
// PUT: persiste a persona; o trigger incrementa `versao`.
// ---------------------------------------------------------------------

async function handlePut(req: Request, db: ServiceClient, usuario: string): Promise<Response> {
  const body: PutBody = await parseJsonBody(req, putBodySchema);

  // Versao anterior para auditoria (E15): lida antes do update.
  const atual = await loadConfig(db);
  const versaoAnterior = typeof atual.versao === "number" ? atual.versao : 0;

  // Deduplica as ferramentas preservando a ordem de entrada.
  const ferramentas = [...new Set(body.ferramentas)];

  // O trigger trg_triagem_agente_config_updated incrementa `versao` e seta
  // atualizado_em; nao enviamos esses campos no patch.
  const { data: updatedRaw, error: upErr } = await db
    .from("triagem_agente_config")
    .update({
      ativo: body.ativo,
      nome: body.nome,
      persona_prompt: body.persona_prompt,
      ferramentas,
      atualizado_por: usuario,
    })
    .eq("singleton", true)
    .select(AGENTE_COLS)
    .maybeSingle();
  if (upErr) {
    throw new Error(`falha ao atualizar triagem_agente_config: ${upErr.message}`);
  }
  if (!updatedRaw) {
    throw new Error("triagem_agente_config ausente (seed nao aplicado)");
  }
  const updated = updatedRaw as unknown as AgenteConfigRow;
  const versaoNova = typeof updated.versao === "number" ? updated.versao : versaoAnterior + 1;

  // Auditoria E15: registra versao anterior/nova (sem persona integral).
  await logSensitiveAction({
    tabela: "triagem_agente_config",
    acao: "agente_config_atualizar",
    usuario,
    dadosAnteriores: { versao: versaoAnterior, ativo: atual.ativo === true },
    dadosNovos: {
      versao: versaoNova,
      ativo: body.ativo,
      nome: body.nome,
      ferramentas,
    },
  });

  return jsonResponse(toResponse(updated), 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "PUT"]);

    // Autorizacao na borda: 401 sem sessao, 403 fora da allowlist.
    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();

    switch (req.method) {
      case "PUT":
        return await handlePut(req, db, ctx.email);
      case "GET":
      default:
        return await handleGet(db);
    }
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
