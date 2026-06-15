// =====================================================================
// Edge Function: v1-substrato-sql
//   -> POST /v1/substrato/sql   (contrato versionado /v1)
//
// Tool #4 do RAG: SQL read-only no SUBSTRATO TABULAR de licitacao. Responde
// o que a busca semantica NAO faz (COUNT, GROUP BY, filtro exato, joins) sobre
// as views curadas do schema lia (avisos, processos, pessoas, documentos,
// documento_vinculos). A Lia RACIOCINA (escreve o SELECT); o banco GARANTE as
// travas deterministicas via RPC executar_sql_lia:
//   - owner read-only lia_sql (SELECT so em lia.*, nada de public);
//   - search_path lia, SELECT/WITH-only (sem ';'), statement_timeout 5s;
//   - LIMIT forcado (cap 1000) com deteccao de truncamento.
//   - Recebe { sql, limite? } e retorna { truncado, row_count, linhas }.
//   - Erro de SQL da Lia (sintaxe, coluna inexistente, escopo) -> 400.
//
// Autenticacao /v1: aceita a API key de servico read-only da Lia (Bearer,
// guardada no Vault) OU a sessao do cockpit. Sem credencial valida -> 401.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, principalLabel } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { normalizeSqlLinhas, parseJsonBody, substratoSqlSchema } from "../_shared/validation.ts";

/** Forma retornada pela RPC public.executar_sql_lia. */
interface ResultadoSql {
  truncado: boolean;
  row_count: number;
  linhas: unknown[];
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao primeiro: nao processa corpo sem credencial valida (401/403).
    const principal = await authenticateV1(req);

    // Validacao server-side (zod) so do envelope. Falha de schema -> 422.
    const { sql, limite } = await parseJsonBody(req, substratoSqlSchema, {
      validationStatus: 422,
    });
    const normalizedLimite = normalizeSqlLinhas(limite);

    // Execucao sob as travas deterministicas da RPC (SECURITY DEFINER lia_sql).
    const service = createServiceClient();
    const { data, error } = await service.rpc("executar_sql_lia", {
      p_sql: sql,
      p_limite: normalizedLimite,
    });
    if (error) {
      // Erro vindo do SELECT da Lia (sintaxe, coluna/relacao inexistente,
      // tentativa fora de escopo, nao-SELECT, ';') = problema do CLIENTE -> 400.
      throw new HttpError(400, "sql_invalido", error.message ?? "consulta invalida");
    }

    const resultado = (data ?? null) as ResultadoSql | null;
    const truncado = Boolean(resultado?.truncado);
    const rowCount = typeof resultado?.row_count === "number" ? resultado.row_count : 0;
    const linhas = Array.isArray(resultado?.linhas) ? resultado.linhas : [];

    // Auditoria: registra a consulta (com o SQL) SEM as linhas retornadas.
    await logSensitiveAction({
      tabela: "lia",
      acao: "substrato_sql",
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        sql,
        limite: normalizedLimite,
        row_count: rowCount,
        truncado,
      },
    });

    return jsonResponse({ truncado, row_count: rowCount, linhas }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "v1-substrato-sql" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
