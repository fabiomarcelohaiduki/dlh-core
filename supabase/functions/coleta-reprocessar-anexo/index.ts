// =====================================================================
// Edge Function: coleta-reprocessar-anexo  ->  POST /coleta-reprocessar-anexo
//
// REPROCESSA UM vinculo (documento_vinculos): devolve-o a fila de extracao
// (status_extracao -> 'pendente'), zera o contador (tentativas_extracao = 0)
// e limpa a mensagem de erro (erro = NULL). O runner do Actions so consome
// 'pendente', entao isto e o que faz um anexo "voltar a fila" pela tela: o
// proximo drain tenta de novo, num novo ciclo de tentativas.
//
// Single-responsibility: SO reprocessa 1 vinculo. Espelha o padrao do
// 'ignorar-anexo' de documentos-descobrir (pre-check + UPDATE condicionado),
// porem como Edge propria (uma responsabilidade, uma funcao).
//
// Idempotente: a allowlist inclui 'pendente', logo rodar 2x com o mesmo id
// produz o mesmo efeito final (segunda chamada apenas reescreve o mesmo
// estado). Allowlist de origem: {erro, inobtenivel, precisa_ocr, pendente}.
//
// Borda de seguranca (SEC):
//   handleCorsPreflight (204 OPTIONS)
//     -> assertMethod(['POST'])
//     -> requireAuthorizedUser (401 sem sessao, 403 fora da allowlist)
//     -> parse body { id } validado com UUID_RE (400 se invalido)
//     -> pre-check SELECT status_extracao (404 ausente; 422 fora da allowlist)
//     -> UPDATE condicionado via service_role (409 se o status mudou na corrida)
//     -> auditoria best-effort (logSensitiveAction) -> jsonResponse.
//
// SEM bypass de sistema: somente sessao humana autorizada escreve aqui.
// Toda escrita via service_role server-side. ZERO migration.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { UUID_RE } from "../_shared/rest.ts";

const FUNCTION_SEGMENT = "coleta-reprocessar-anexo";

// Allowlist de origem do reprocesso. Inclui 'pendente' (idempotencia): rodar
// de novo num vinculo ja pendente reescreve o mesmo estado, sem efeito visivel.
// Nunca toca sucesso (extraido/herdado) nem 'ignorado' (terminal manual).
const STATUS_REPROCESSAVEIS = ["erro", "inobtenivel", "precisa_ocr", "pendente"] as const;
type StatusReprocessavel = typeof STATUS_REPROCESSAVEIS[number];

function ehReprocessavel(status: string): status is StatusReprocessavel {
  return (STATUS_REPROCESSAVEIS as readonly string[]).includes(status);
}

/** Le o corpo JSON da requisicao de forma tolerante (objeto vazio se invalido). */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Extrai e valida o id (uuid) do vinculo a reprocessar. */
function parseId(body: Record<string, unknown>): string {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!UUID_RE.test(id)) {
    throw new HttpError(400, "id_invalido", "informe o id (uuid) do vinculo");
  }
  return id;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    // Borda: metodo antes da autenticacao; autenticacao antes do corpo.
    assertMethod(req, "POST");
    const { email } = await requireAuthorizedUser(req);
    const body = await readBody(req);
    const id = parseId(body);

    const service = createServiceClient();

    // Pre-check: existencia + status atual. registro_origem_id/binding via .eq
    // (parametrizado, nunca concatenado).
    const { data: row, error: selErr } = await service
      .from("documento_vinculos")
      .select("status_extracao")
      .eq("id", id)
      .maybeSingle();
    if (selErr) {
      throw new HttpError(500, "reprocessar_falhou", "falha ao ler o vinculo");
    }
    if (!row) {
      throw new HttpError(404, "vinculo_nao_encontrado", "vinculo de documento nao encontrado");
    }
    const statusAnterior = String(row.status_extracao);
    if (!ehReprocessavel(statusAnterior)) {
      throw new HttpError(
        422,
        "status_nao_reprocessavel",
        "apenas anexos em erro, inacessiveis, na fila de OCR ou pendentes podem ser reprocessados",
      );
    }

    // UPDATE condicionado a allowlist (fecha a janela TOCTOU: o status pode
    // mudar entre o SELECT e o UPDATE, ex.: um run concorrente reextrai o
    // anexo). 0 linhas afetadas = o status saiu da allowlist no meio -> 409.
    const { data: atualizadas, error: updErr } = await service
      .from("documento_vinculos")
      .update({
        status_extracao: "pendente",
        tentativas_extracao: 0,
        erro: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .in("status_extracao", STATUS_REPROCESSAVEIS)
      .select("id");
    if (updErr) {
      throw new HttpError(500, "reprocessar_falhou", "falha ao reprocessar o anexo");
    }
    if (!atualizadas || atualizadas.length === 0) {
      throw new HttpError(
        409,
        "status_mudou",
        "o status do anexo mudou antes do reprocesso; recarregue e tente de novo",
      );
    }

    // Auditoria da escrita (best-effort): ocorre APOS o UPDATE e ANTES da
    // resposta. Uma falha aqui nao derruba o fluxo (logSensitiveAction nunca
    // propaga; reporta ao Sentry internamente).
    await logSensitiveAction({
      tabela: "documento_vinculos",
      acao: "reprocessar_anexo_extracao",
      registroId: id,
      usuario: email,
      dadosAnteriores: { status: statusAnterior },
      dadosNovos: { status: "pendente", tentativas_extracao: 0 },
    });

    return jsonResponse({ ok: true, id }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

getEnv();

Deno.serve(handler);
