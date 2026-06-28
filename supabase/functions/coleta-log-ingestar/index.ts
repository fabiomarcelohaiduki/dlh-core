// =====================================================================
// Edge Function: coleta-log-ingestar  ->  POST /coleta-log-ingestar
// Ponta do PC do console ao vivo: o servico de poll local empurra as linhas
// de stdout/stderr dos wrappers .ps1 (Nomus, Tika/OCR) para coleta_log, de
// onde o cockpit as le pela Edge coleta-log (carga) e pelo Supabase Realtime
// (stream). O PC nao conhece execucao_id; vincula a linha pelo comando_id.
//
// POR QUE EXISTE (decisao Fabio 2026-06-28):
//   As coletas Edge (Effecti/Gmail/Drive) ja gravam coleta_log via service_role
//   (helper _shared/coleta-log.ts). O PC (Nomus/Tika) produz stdout/stderr reais
//   nos wrappers, invisiveis ao cockpit. Esta Edge e o destino dessas linhas: o
//   comando-poll.mjs as envia em lotes (1 round-trip por flush) e cada linha vira
//   um INSERT que o Realtime entrega ao console do usuario.
//
// AUTENTICACAO: X-Cron-Secret (matchesCronSecret) — o PC nao tem service_role,
//   so o cron secret (igual a comando-local-fila). verify_jwt DESLIGADO no
//   config.toml (chamada sem header Authorization -> o gateway barraria antes).
//
// CONTRATO (POST):
//   { comando_id: uuid, origem: nomus|tika|sistema, linhas: [{ mensagem, nivel? }] }
//   nivel default 'info'; mensagem truncada em MSG_MAX; lote limitado a LOTE_MAX.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { matchesCronSecret } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";

// So as fontes do PC; Edge usa o helper direto (effecti/gmail/drive).
const ORIGENS_PC = ["nomus", "tika", "sistema"] as const;
type OrigemPc = (typeof ORIGENS_PC)[number];
const NIVEIS = ["info", "warn", "erro"] as const;
type Nivel = (typeof NIVEIS)[number];

const MSG_MAX = 2000;
const LOTE_MAX = 500;

function ehOrigemPc(v: unknown): v is OrigemPc {
  return typeof v === "string" && (ORIGENS_PC as readonly string[]).includes(v);
}

function normalizarNivel(v: unknown): Nivel {
  return typeof v === "string" && (NIVEIS as readonly string[]).includes(v) ? (v as Nivel) : "info";
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    if (!(await matchesCronSecret(req))) {
      throw new HttpError(401, "no_auth", "cron secret invalido ou ausente");
    }

    let body: { comando_id?: unknown; origem?: unknown; linhas?: unknown };
    try {
      body = await req.json();
    } catch (_) {
      throw new HttpError(400, "body_invalido", "corpo JSON invalido");
    }

    const comandoId = typeof body.comando_id === "string" && body.comando_id ? body.comando_id : null;
    if (!comandoId) {
      throw new HttpError(400, "comando_id_invalido", "comando_id obrigatorio");
    }
    if (!ehOrigemPc(body.origem)) {
      throw new HttpError(400, "origem_invalida", "origem deve ser nomus, tika ou sistema");
    }
    if (!Array.isArray(body.linhas)) {
      throw new HttpError(400, "linhas_invalidas", "linhas deve ser um array");
    }

    const origem = body.origem;
    const linhas = (body.linhas as unknown[])
      .slice(0, LOTE_MAX)
      .map((raw) => {
        const linha = (raw ?? {}) as { mensagem?: unknown; nivel?: unknown };
        const mensagem = typeof linha.mensagem === "string" ? linha.mensagem.slice(0, MSG_MAX) : "";
        return { comando_id: comandoId, origem, nivel: normalizarNivel(linha.nivel), mensagem };
      })
      .filter((l) => l.mensagem.length > 0);

    if (linhas.length === 0) {
      return jsonResponse({ ok: true, inseridas: 0 });
    }

    const service = createServiceClient();
    const { error } = await service.from("coleta_log").insert(linhas);
    if (error) {
      throw new HttpError(500, "coleta_log_insert_failed", "falha ao gravar as linhas de log");
    }

    return jsonResponse({ ok: true, inseridas: linhas.length });
  } catch (err) {
    return await errorResponse(err, { fn: "coleta-log-ingestar" });
  }
}

getEnv();

Deno.serve(handler);
