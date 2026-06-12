import { apiFetch } from "@/lib/api/client";
import type { ConfigExtracaoState } from "@/lib/api/types";

// ---------------------------------------------------------------------
// Cliente do Edge documentos-descobrir (camada 1 do pipeline de documentos).
//   - descobrirAnexos: enfileira documento_vinculos pendentes a partir dos
//     anexos ja presentes em nomus_processos (idempotente).
//   - fetchExtracaoResumo: contagens por status + anexos que falharam.
// Variaveis em camelCase; o Edge ja aceita camel no body.
// ---------------------------------------------------------------------

/** Fontes que tem funcao de descoberta de anexos (mesma fila, adaptador por fonte). */
export type FonteDescoberta = "nomus" | "effecti";

export interface DescobrirInput {
  /** Fonte da descoberta. Default 'nomus'. */
  fonte?: FonteDescoberta;
  /** So Nomus: filtra nomus_processos.tipo (ex.: 'Venda Governamental'). */
  tipo?: string | null;
  /** Allowlist de extensoes (sem ponto). Ausente = todas. */
  extensoes?: string[] | null;
  /** Teto de PROCESSOS varridos (id DESC). Ausente = todos. */
  limiteProcessos?: number | null;
}

export interface DescobrirResultado {
  fonte: string;
  inseridos: number;
}

/** POST /documentos-descobrir — enfileira anexos pendentes. */
export function descobrirAnexos(input: DescobrirInput = {}): Promise<DescobrirResultado> {
  const body: Record<string, unknown> = { fonte: input.fonte ?? "nomus" };
  if (input.tipo !== undefined) body.tipo = input.tipo;
  if (input.extensoes !== undefined) body.extensoes = input.extensoes;
  if (input.limiteProcessos !== undefined) body.limiteProcessos = input.limiteProcessos;
  return apiFetch<DescobrirResultado>("documentos-descobrir", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Fontes que podem ter vinculos com erro (mais ampla que as descobriveis). */
export type FonteReprocessavel = "nomus" | "effecti" | "gmail" | "drive";

export interface ReprocessarErrosResultado {
  reprocessados: number;
  fonte: FonteReprocessavel | null;
}

/**
 * POST /documentos-descobrir { action:'reprocessar-erros' } — re-enfileira os
 * vinculos com erro (status 'erro' -> 'pendente'). Fonte opcional (ausente =
 * todas). O proximo drain da fila tenta de novo (ex.: apos fix no extrator).
 */
export function reprocessarErros(
  fonte?: FonteReprocessavel | null,
): Promise<ReprocessarErrosResultado> {
  const body: Record<string, unknown> = { action: "reprocessar-erros" };
  if (fonte) body.fonte = fonte;
  return apiFetch<ReprocessarErrosResultado>("documentos-descobrir", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface ExtracaoErro {
  id: string;
  fonte: string | null;
  processoId: string | null;
  nomeAnexo: string | null;
  extensao: string | null;
  url: string | null;
  erro: string | null;
  quando: string | null;
}

export interface ExtracaoResumo {
  contagens: {
    pendente: number;
    extraido: number;
    herdado: number;
    erro: number;
    total: number;
  };
  erros: ExtracaoErro[];
}

interface ExtracaoResumoRaw {
  contagens?: Partial<ExtracaoResumo["contagens"]>;
  erros?: Array<Partial<ExtracaoErro> & { id: string }>;
}

/** POST /documentos-descobrir { action:'resumo' } — status + erros de extracao. */
export function fetchExtracaoResumo(): Promise<ExtracaoResumo> {
  return apiFetch<ExtracaoResumoRaw>("documentos-descobrir", {
    method: "POST",
    body: JSON.stringify({ action: "resumo" }),
  }).then((raw) => ({
    contagens: {
      pendente: raw.contagens?.pendente ?? 0,
      extraido: raw.contagens?.extraido ?? 0,
      herdado: raw.contagens?.herdado ?? 0,
      erro: raw.contagens?.erro ?? 0,
      total: raw.contagens?.total ?? 0,
    },
    erros: (raw.erros ?? []).map((e) => ({
      id: e.id,
      fonte: e.fonte ?? null,
      processoId: e.processoId ?? null,
      nomeAnexo: e.nomeAnexo ?? null,
      extensao: e.extensao ?? null,
      url: e.url ?? null,
      erro: e.erro ?? null,
      quando: e.quando ?? null,
    })),
  }));
}

// ---------------------------------------------------------------------
// Config da camada 1 do extrator (singleton config_extracao). A LEITURA
// e hidratada server-side via RLS na pagina Fontes; aqui fica so a ESCRITA
// (PUT), que precisa passar pelo Edge (service_role + audit). Contrato em
// camelCase; o Edge mapeia para snake e valida (extracaoConfigSchema).
// ---------------------------------------------------------------------

/** Payload (camel) do PUT /extracao-config — substitui a config inteira. */
export type SalvarConfigExtracaoInput = ConfigExtracaoState;

/**
 * PUT /extracao-config — persiste os parametros da camada 1 do extrator. Vale
 * na PROXIMA execucao do runner (sem redeploy); nao afeta um job em andamento.
 */
export function salvarConfigExtracao(
  input: SalvarConfigExtracaoInput,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("extracao-config", {
    method: "PUT",
    body: JSON.stringify({
      ocrEstrategia: input.ocrEstrategia,
      ocrIdioma: input.ocrIdioma,
      tamanhoMaxBytes: input.tamanhoMaxBytes,
      timeoutMs: input.timeoutMs,
      extensoesHabilitadas: input.extensoesHabilitadas,
      fontesHabilitadas: input.fontesHabilitadas,
      loteTamanho: input.loteTamanho,
      pausaLoteMs: input.pausaLoteMs,
    }),
  });
}
