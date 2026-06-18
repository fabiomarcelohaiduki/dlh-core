// =====================================================================
// Edge Function: v1-triagem-fila  (Caminho 2 - entrega de trabalho ao Lion)
//   -> GET /v1-triagem-fila?limite=&cursor=
//
// Pagina a FILA de triagem (contrato 3.2.1): lista avisos JA indexados e
// AINDA nao triados, ja enriquecidos com os insumos que o Lion precisa para
// decidir (trechos do edital, LISTA DE ITENS do edital + documentos com
// itens_status, few-shot ativo, regras duras) e, no topo, o objeto `agente`
// versionado. O servidor NAO cruza com o catalogo nem chama LLM aqui — entrega
// os itens literais (documento_itens) e a propria Lia cruza/decide.
//
// Autenticacao (RNF-01 / SEC-1 / SEC-4): authenticateV1 com requiredScope
// read-only:busca-semantica autoriza NA BORDA, antes de qualquer montagem de
// insumo. Sem credencial -> 401; credencial sem o escopo (ex.: write:triagem)
// ou sessao humana -> 403. A montagem roda via service_role (a RPC de busca
// e SECURITY DEFINER). logSensitiveAction registra principal + contagem, sem
// conteudo de aviso/edital.
//
// Query params: `limite` (default 20, cap 50 — clampado, nao rejeita) e
// `cursor` (uuid opcional para keyset FIFO; uuid invalido -> 400).
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, LIA_SERVICE_SCOPE, principalLabel } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { buildTriagemFila, normalizeFilaLimite } from "../_shared/triagem-fila.ts";

const FUNCTION_SEGMENT = "v1-triagem-fila";

/** Validacao do cursor opcional (uuid); ausente/vazio => sem cursor. */
const cursorSchema = z.string().uuid("cursor deve ser um uuid valido");

function parseCursor(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = cursorSchema.safeParse(trimmed);
  if (!parsed.success) {
    throw new HttpError(400, "cursor_invalido", "cursor deve ser um uuid valido");
  }
  return parsed.data;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");

    // Autorizacao na borda: recurso EXCLUSIVO de servico read-only (FILA).
    // Sem credencial -> 401; escopo != read-only:busca-semantica -> 403.
    // Nenhum insumo e montado antes deste ponto.
    const principal = await authenticateV1(req, { requiredScope: LIA_SERVICE_SCOPE });

    // Query params: limite (default 20, cap 50) e cursor (uuid opcional).
    const url = new URL(req.url);
    const limite = normalizeFilaLimite(url.searchParams.get("limite"));
    const cursor = parseCursor(url.searchParams.get("cursor"));

    // Monta a pagina da fila (agente + itens + next_cursor) via service_role.
    const result = await buildTriagemFila({ limite, cursor });

    // Auditoria do acesso /v1: principal + contagem; SEM conteudo de avisos.
    await logSensitiveAction({
      tabela: "avisos",
      acao: "v1_triagem_fila",
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        limite,
        cursor,
        itens: result.itens.length,
        next_cursor: result.next_cursor,
      },
    });

    return jsonResponse(result, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
