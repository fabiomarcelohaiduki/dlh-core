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
  const idInicial = typeof o.id_inicial === "number" && Number.isFinite(o.id_inicial)
    ? Math.floor(o.id_inicial)
    : null;
  const dataInicial = typeof o.data_inicial === "string" ? o.data_inicial : null;
  const janelaDias = typeof o.janela_dias === "number" && Number.isFinite(o.janela_dias)
    ? Math.floor(o.janela_dias)
    : null;
  return {
    ativo: typeof o.ativo === "boolean" ? o.ativo : false,
    tiposAtivos,
    usaFiltroDataAlteracao:
      typeof o.usa_filtro_data_alteracao === "boolean" ? o.usa_filtro_data_alteracao : undefined,
    etapasTerminais,
    idInicial,
    dataInicial,
    janelaDias,
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
  /** Janela por recurso: corte por nomus_id. null limpa o corte. */
  idInicial?: number | null;
  /** Janela por recurso: corte por data de criacao 'YYYY-MM-DD'. null limpa. */
  dataInicial?: string | null;
}

/** Payload (camel) do PUT /ingestao-config para a fonte. */
export interface SalvarIngestaoConfigInput {
  fonte: FonteTipo;
  janelaDias?: number;
  /** Data de corte 'YYYY-MM-DD' (Nomus): ignora processos criados antes dela.
   *  null limpa o filtro (volta a coletar tudo). */
  dataInicial?: string | null;
  recursos?: Record<string, RecursoPatch>;
}

/**
 * PUT /ingestao-config — persiste janela/data_inicial e recursos/tipos da
 * fonte. As alteracoes valem na PROXIMA execucao (sem redeploy); o backend faz
 * merge raso por recurso (campos nao enviados sao preservados). Variaveis em
 * camelCase; payload em snake_case.
 */
export function salvarIngestaoConfig(
  input: SalvarIngestaoConfigInput,
): Promise<{ ok: boolean }> {
  const body: Record<string, unknown> = { fonte: input.fonte };
  if (input.janelaDias !== undefined) body.janela_dias = input.janelaDias;
  if (input.dataInicial !== undefined) body.data_inicial = input.dataInicial;
  if (input.recursos !== undefined) {
    const recursos: Record<string, Record<string, unknown>> = {};
    for (const [key, patch] of Object.entries(input.recursos)) {
      const entry: Record<string, unknown> = {};
      if (patch.ativo !== undefined) entry.ativo = patch.ativo;
      if (patch.tiposAtivos !== undefined) entry.tipos_ativos = patch.tiposAtivos;
      if (patch.usaFiltroDataAlteracao !== undefined) {
        entry.usa_filtro_data_alteracao = patch.usaFiltroDataAlteracao;
      }
      if (patch.idInicial !== undefined) entry.id_inicial = patch.idInicial;
      if (patch.dataInicial !== undefined) entry.data_inicial = patch.dataInicial;
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
  /**
   * Retomada manual (botao "Retomar", so Effecti): id da execucao em erro a
   * retomar do checkpoint EXATO. Ignorado pelo Nomus (inicia coleta nova).
   */
  retomarExecucaoId?: string;
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
  if (input.retomarExecucaoId) body.retomarExecucaoId = input.retomarExecucaoId;
  return apiFetch<ColetaNomusRaw>("ingestao-coletar", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((r) => ({
    execucaoId: r.execucao_id,
    estado: r.estado,
    jaEmAndamento: r.ja_em_andamento,
  }));
}
