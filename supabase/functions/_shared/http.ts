// =====================================================================
// _shared/http.ts
// Erros tipados e respostas JSON padronizadas (codigos HTTP corretos,
// payload de erro consistente). Tratamento de erro explicito: nunca
// engolir excecoes — erros desconhecidos viram 500 e sao capturados pelo
// Sentry no handler de cada funcao.
// =====================================================================

import { corsHeaders } from "./cors.ts";
import { captureException } from "./audit.ts";

/** Erro de aplicacao com status HTTP e codigo de maquina. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** Resposta JSON com CORS e Content-Type aplicados. */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

/**
 * Converte qualquer erro em Response padronizada.
 * - HttpError: usa status/code/message proprios (causa conhecida).
 * - Demais: 500 generico (mensagem interna nao vaza), com captura no Sentry.
 */
export async function errorResponse(
  error: unknown,
  context: Record<string, unknown> = {},
): Promise<Response> {
  if (error instanceof HttpError) {
    const body: ErrorBody = { error: { code: error.code, message: error.message } };
    return jsonResponse(body, error.status);
  }

  // Causa desconhecida: log estruturado + Sentry, sem vazar detalhes ao cliente.
  const message = error instanceof Error ? error.message : String(error);
  console.error("[http] erro nao tratado", { message, ...context });
  await captureException(error, context);

  const body: ErrorBody = {
    error: { code: "internal_error", message: "erro interno do servidor" },
  };
  return jsonResponse(body, 500);
}

/** Metodos HTTP suportados pelas Edge Functions do cockpit. */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Garante que o metodo da requisicao esta entre os esperados; senao lanca 405.
 * Aceita um unico metodo (compat) ou uma lista (endpoints CRUD multi-metodo).
 */
export function assertMethod(req: Request, expected: HttpMethod | HttpMethod[]): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(req.method as HttpMethod)) {
    throw new HttpError(
      405,
      "method_not_allowed",
      `metodo nao permitido: use ${allowed.join(", ")}`,
    );
  }
}
