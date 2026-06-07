import { apiFetch } from "@/lib/api/client";
import type {
  ColetaResponse,
  ErrosResponse,
  ExecucoesResponse,
  HealthcheckResponse,
} from "@/lib/api/types";

/** GET /ingestao/healthcheck — KPIs e saude do pipeline (api-healthcheck). */
export function fetchHealthcheck(signal?: AbortSignal): Promise<HealthcheckResponse> {
  return apiFetch<HealthcheckResponse>("ingestao-healthcheck", {
    method: "GET",
    signal,
  });
}

/** GET /ingestao/execucoes?limit= — historico de coletas (api-listar-execucoes). */
export function fetchExecucoes(
  limit: number,
  signal?: AbortSignal,
): Promise<ExecucoesResponse> {
  const qs = new URLSearchParams({ limit: String(limit) });
  return apiFetch<ExecucoesResponse>(`ingestao-execucoes?${qs.toString()}`, {
    method: "GET",
    signal,
  });
}

/** GET /ingestao/erros?etapa= — erros de ingestao (api-listar-erros). */
export function fetchErros(
  etapa: string | undefined,
  signal?: AbortSignal,
): Promise<ErrosResponse> {
  const qs = new URLSearchParams();
  if (etapa && etapa !== "todos") qs.set("etapa", etapa);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch<ErrosResponse>(`ingestao-erros${suffix}`, {
    method: "GET",
    signal,
  });
}

/** POST /ingestao/coletar — dispara coleta sob demanda (api-coleta-demanda). */
export function dispararColeta(janelaDias?: number): Promise<ColetaResponse> {
  return apiFetch<ColetaResponse>("ingestao-coletar", {
    method: "POST",
    body: JSON.stringify({ fonte: "effecti", ...(janelaDias ? { janelaDias } : {}) }),
  });
}
