import { apiFetch } from "@/lib/api/client";
import type {
  ColetarResponse,
  FonteTipo,
  IngestaoConfig,
  RecursoConfig,
} from "@/lib/api/types";

// ---------------------------------------------------------------------
// Contrato cru (snake_case) das Edge Functions ingestao-config / coletar.
// O backend e a fonte de verdade; aqui mapeamos snake -> camel para o front.
// ---------------------------------------------------------------------

interface IngestaoConfigRaw {
  fonte: string;
  janela_dias: number | null;
  data_inicial: string | null;
  recursos: Record<string, unknown>;
}

interface ColetaNomusRaw {
  execucao_id: string;
  estado: "em_andamento";
  ja_em_andamento?: boolean;
}

/** Normaliza um registro de recurso cru (snake) para RecursoConfig (camel). */
function toRecursoConfig(raw: unknown): RecursoConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tiposAtivos = Array.isArray(o.tipos_ativos)
    ? o.tipos_ativos.filter((v): v is string => typeof v === "string")
    : [];
  const etapasTerminais = Array.isArray(o.etapas_terminais)
    ? o.etapas_terminais.filter((v): v is string => typeof v === "string")
    : undefined;
  return {
    ativo: typeof o.ativo === "boolean" ? o.ativo : false,
    tiposAtivos,
    usaFiltroDataAlteracao:
      typeof o.usa_filtro_data_alteracao === "boolean" ? o.usa_filtro_data_alteracao : undefined,
    etapasTerminais,
  };
}

function toIngestaoConfig(raw: IngestaoConfigRaw): IngestaoConfig {
  const recursos: Record<string, RecursoConfig> = {};
  for (const [key, value] of Object.entries(raw.recursos ?? {})) {
    recursos[key] = toRecursoConfig(value);
  }
  return {
    fonte: (raw.fonte as FonteTipo) ?? "nomus",
    janelaDias: raw.janela_dias,
    dataInicial: raw.data_inicial,
    recursos,
  };
}

/**
 * GET /ingestao-config?fonte= — le a config corrente da fonte (janela +
 * recursos/tipos). Sem config persistida o backend devolve recursos = {}.
 */
export function fetchIngestaoConfig(fonte: FonteTipo): Promise<IngestaoConfig> {
  const qs = new URLSearchParams({ fonte });
  return apiFetch<IngestaoConfigRaw>(`ingestao-config?${qs.toString()}`, {
    method: "GET",
  }).then(toIngestaoConfig);
}

/** Alteracao parcial de um recurso (camel) enviada no PUT. */
export interface RecursoPatch {
  ativo?: boolean;
  tiposAtivos?: string[];
  usaFiltroDataAlteracao?: boolean;
}

/** Payload (camel) do PUT /ingestao-config para a fonte. */
export interface SalvarIngestaoConfigInput {
  fonte: FonteTipo;
  janelaDias?: number;
  recursos?: Record<string, RecursoPatch>;
}

/**
 * PUT /ingestao-config — persiste janela e recursos/tipos da fonte. As
 * alteracoes valem na PROXIMA execucao (sem redeploy); o backend faz merge
 * raso por recurso (campos nao enviados sao preservados). data_inicial NAO e
 * exposta nesta entrega. Variaveis em camelCase; payload em snake_case.
 */
export function salvarIngestaoConfig(
  input: SalvarIngestaoConfigInput,
): Promise<{ ok: boolean }> {
  const body: Record<string, unknown> = { fonte: input.fonte };
  if (input.janelaDias !== undefined) body.janela_dias = input.janelaDias;
  if (input.recursos !== undefined) {
    const recursos: Record<string, Record<string, unknown>> = {};
    for (const [key, patch] of Object.entries(input.recursos)) {
      const entry: Record<string, unknown> = {};
      if (patch.ativo !== undefined) entry.ativo = patch.ativo;
      if (patch.tiposAtivos !== undefined) entry.tipos_ativos = patch.tiposAtivos;
      if (patch.usaFiltroDataAlteracao !== undefined) {
        entry.usa_filtro_data_alteracao = patch.usaFiltroDataAlteracao;
      }
      recursos[key] = entry;
    }
    body.recursos = recursos;
  }
  return apiFetch<{ ok: boolean }>("ingestao-config", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Payload (camel) do POST /ingestao-coletar. */
export interface ColetarInput {
  fonte: FonteTipo;
  recurso?: "processos";
  janelaDias?: number;
}

/**
 * POST /ingestao-coletar — dispara a coleta manual da fonte/recurso. Retorna
 * 202 { execucaoId, estado } na criacao e 409 (ApiError) quando ja existe
 * coleta em andamento (single-flight global).
 */
export function coletar(input: ColetarInput): Promise<ColetarResponse> {
  const body: Record<string, unknown> = { fonte: input.fonte };
  if (input.recurso) body.recurso = input.recurso;
  if (input.janelaDias !== undefined) body.janelaDias = input.janelaDias;
  return apiFetch<ColetaNomusRaw>("ingestao-coletar", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((r) => ({
    execucaoId: r.execucao_id,
    estado: r.estado,
    jaEmAndamento: r.ja_em_andamento,
  }));
}
