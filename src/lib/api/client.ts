import type { ApiErrorBody } from "@/lib/api/types";

/**
 * Erro tipado de chamada as Edge Functions. `status` permite a UI distinguir
 * o anti-duplo-disparo (409 `execucao_em_andamento`) de falhas genericas.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const PROXY_BASE = "/proxy";

/**
 * Fetcher autenticado para as Edge Functions, via proxy server-side (/proxy).
 * A sessao vive em cookies httpOnly e nao e legivel por scripts no browser;
 * por isso o Route Handler do proxy le a sessao no servidor e anexa o Bearer
 * do usuario antes de encaminhar a chamada. O RLS do usuario autorizado e
 * respeitado server-side em cada endpoint.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${PROXY_BASE}/${path}`, { ...init, headers });

  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // resposta sem corpo JSON; mantem fallback abaixo.
    }
    throw new ApiError(
      res.status,
      body?.error ?? "request_failed",
      body?.message ?? res.statusText ?? "falha na requisicao",
    );
  }

  // 204/sem corpo: retorna objeto vazio tipado.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
