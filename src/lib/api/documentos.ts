import { apiFetch } from "@/lib/api/client";
import type { ConfigExtracaoState } from "@/lib/api/types";

// ---------------------------------------------------------------------
// Cliente do Edge documentos-descobrir (camada 1 do pipeline de documentos).
//   - descobrirAnexos: enfileira documento_vinculos pendentes a partir dos
//     anexos ja presentes em nomus_processos (idempotente).
//   - fetchExtracaoFila: pagina a fila de extracao por keyset (guia "Fila de
//     extracao" da Coleta). Variaveis em camelCase; o Edge ja aceita camel.
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

/** Status terminal que o reprocesso manual ressuscita (contextual ao card). */
export type StatusReprocessavel = "erro" | "inobtenivel" | "ignorado";

export interface ReprocessarErrosResultado {
  reprocessados: number;
  fonte: FonteReprocessavel | null;
  status: StatusReprocessavel;
}

/**
 * POST /documentos-descobrir { action:'reprocessar-erros' } — re-enfileira os
 * vinculos terminais (status alvo -> 'pendente'). 'status' = contextual ao card
 * selecionado: 'erro' (transitorios, default) ou 'inobtenivel' (inacessiveis;
 * so o manual os ressuscita). Fonte opcional (ausente = todas). O proximo drain
 * da fila tenta de novo, com novo ciclo de tentativas (contador zerado).
 */
export function reprocessarErros(
  fonte?: FonteReprocessavel | null,
  status: StatusReprocessavel = "erro",
): Promise<ReprocessarErrosResultado> {
  const body: Record<string, unknown> = { action: "reprocessar-erros", status };
  if (fonte) body.fonte = fonte;
  return apiFetch<ReprocessarErrosResultado>("documentos-descobrir", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface SubstituirLinkResultado {
  ok: boolean;
  id: string;
}

export interface IgnorarAnexoResultado {
  ok: boolean;
  id: string;
}

export interface ReprocessarAnexoResultado {
  ok: boolean;
  id: string;
}

/**
 * POST /coleta-reprocessar-anexo — re-enfileira UM vinculo (qualquer fonte)
 * cujo status_extracao esteja terminal/recuperavel (erro, inobtenivel,
 * precisa_ocr, pendente): SET status_extracao='pendente', tentativas_extracao=0.
 * Acao granular por vinculo da guia "Dados" (paritaria ao ignorarAnexo, porem
 * via Edge propria com UPDATE condicional + auditoria). O proximo drain da fila
 * tenta de novo. 404 (vinculo ausente), 422 (status nao recuperavel) e 409
 * (status mudou na corrida) chegam como ApiError.
 */
export function reprocessarAnexo(vinculoId: string): Promise<ReprocessarAnexoResultado> {
  return apiFetch<ReprocessarAnexoResultado>("coleta-reprocessar-anexo", {
    method: "POST",
    body: JSON.stringify({ id: vinculoId }),
  });
}

/**
 * POST /documentos-descobrir { action:'ignorar-anexo' } — marca UM vinculo como
 * 'ignorado' (status terminal aplicado manualmente pelo humano). Caso de uso: ao
 * avaliar um anexo em Erros/Inacessiveis, o humano decide que ele e dispensavel;
 * o anexo sai das listas e nao volta a ser processado. Vale para qualquer fonte.
 * Reversivel pelo card "Ignorados" (reprocessa 'ignorado' -> 'pendente').
 */
export function ignorarAnexo(id: string): Promise<IgnorarAnexoResultado> {
  return apiFetch<IgnorarAnexoResultado>("documentos-descobrir", {
    method: "POST",
    body: JSON.stringify({ action: "ignorar-anexo", id }),
  });
}

/** Status de falha que o "ignorar em massa" aceita (contextual ao card). */
export type StatusIgnoravelEmMassa = "erro" | "inobtenivel";

export interface IgnorarEmMassaResultado {
  ignorados: number;
  fonte: FonteReprocessavel | null;
  status: StatusIgnoravelEmMassa;
}

/**
 * POST /documentos-descobrir { action:'ignorar-em-massa' } — marca TODOS os
 * anexos de um status de falha como 'ignorado' de uma vez (versao em massa do
 * ignorar-anexo). 'status' = contextual ao card: 'erro' (default) ou
 * 'inobtenivel'. Fonte opcional (ausente = todas). O humano avaliou a lista e
 * decidiu que todos sao dispensaveis. Reversivel em massa pelo card "Ignorados"
 * (reprocessa 'ignorado' -> 'pendente').
 */
export function ignorarEmMassa(
  fonte?: FonteReprocessavel | null,
  status: StatusIgnoravelEmMassa = "erro",
): Promise<IgnorarEmMassaResultado> {
  const body: Record<string, unknown> = { action: "ignorar-em-massa", status };
  if (fonte) body.fonte = fonte;
  return apiFetch<IgnorarEmMassaResultado>("documentos-descobrir", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * POST /documentos-descobrir { action:'substituir-link' } — troca a URL do
 * anexo de UM vinculo Effecti e o re-enfileira (status 'pendente', contador
 * zerado). Caso de uso: o portal republicou o edital e o link capturado pela
 * Effecti morreu (5xx); o humano cola o link atual do portal. So Effecti.
 */
export function substituirLink(id: string, url: string): Promise<SubstituirLinkResultado> {
  return apiFetch<SubstituirLinkResultado>("documentos-descobrir", {
    method: "POST",
    body: JSON.stringify({ action: "substituir-link", id, url }),
  });
}

/** Status do vinculo que a tabela lista (todos os cards sao clicaveis). */
export type StatusItemExtracao =
  | "pendente"
  | "extraido"
  | "herdado"
  | "erro"
  | "precisa_ocr"
  | "inobtenivel"
  | "ignorado";

export interface ExtracaoItem {
  id: string;
  /** Status do vinculo (define em qual card/aba ele aparece). */
  status: StatusItemExtracao;
  fonte: string | null;
  processoId: string | null;
  nomeAnexo: string | null;
  extensao: string | null;
  /** Link do anexo na origem (arquivo). */
  url: string | null;
  /** Link do aviso/processo no portal (so Effecti). */
  avisoUrl: string | null;
  erro: string | null;
  quando: string | null;
}

// ---------------------------------------------------------------------
// Fila de extracao PAGINADA (guia "Fila de extracao"). Diferente do resumo
// (que capa cada status em 200 e le tudo no Deno), aqui a pagina vem do
// Postgres via keyset -> recall total, sem cap. Cursor opaco {u,k} (u=
// updated_at ISO, k=id). Contagens por fonte (chips), por status (cards)
// e total chegam junto. O item usa o MESMO formato de ExtracaoItem.
// ---------------------------------------------------------------------

/** Cursor opaco do keyset da fila (updated_at DESC, id ASC). */
export interface ExtracaoFilaCursor {
  u: string;
  k: string;
}

export interface ExtracaoFilaParams {
  fonte?: FonteReprocessavel | null;
  status?: StatusItemExtracao | null;
  busca?: string | null;
  cursor?: ExtracaoFilaCursor | null;
  limit?: number;
}

export interface ExtracaoFilaContagens {
  porFonte: { effecti: number; nomus: number; gmail: number; drive: number };
  porStatus: {
    pendente: number;
    extraido: number;
    herdado: number;
    erro: number;
    precisa_ocr: number;
    inobtenivel: number;
    ignorado: number;
  };
  total: number;
}

export interface ExtracaoFilaResponse {
  itens: ExtracaoItem[];
  nextCursor: ExtracaoFilaCursor | null;
  contagens: ExtracaoFilaContagens;
}

interface ExtracaoFilaRaw {
  itens?: Array<Partial<ExtracaoItem> & { id: string; status: StatusItemExtracao }>;
  nextCursor?: ExtracaoFilaCursor | null;
  contagens?: {
    porFonte?: Partial<ExtracaoFilaContagens["porFonte"]>;
    porStatus?: Partial<ExtracaoFilaContagens["porStatus"]>;
    total?: number;
  };
}

/**
 * POST /documentos-descobrir { action:'fila-paginada' } — uma pagina (keyset)
 * da fila de extracao + contagens. Filtros fonte/status/busca opcionais; cursor
 * ausente = primeira pagina. nextCursor null = fim da fila.
 */
export function fetchExtracaoFila(
  params: ExtracaoFilaParams = {},
): Promise<ExtracaoFilaResponse> {
  const body: Record<string, unknown> = { action: "fila-paginada" };
  if (params.fonte) body.fonte = params.fonte;
  if (params.status) body.status = params.status;
  if (params.busca) body.busca = params.busca;
  if (params.cursor) body.cursor = params.cursor;
  if (params.limit !== undefined) body.limit = params.limit;
  return apiFetch<ExtracaoFilaRaw>("documentos-descobrir", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((raw) => ({
    itens: (raw.itens ?? []).map((e) => ({
      id: e.id,
      status: e.status,
      fonte: e.fonte ?? null,
      processoId: e.processoId ?? null,
      nomeAnexo: e.nomeAnexo ?? null,
      extensao: e.extensao ?? null,
      url: e.url ?? null,
      avisoUrl: e.avisoUrl ?? null,
      erro: e.erro ?? null,
      quando: e.quando ?? null,
    })),
    nextCursor: raw.nextCursor ?? null,
    contagens: {
      porFonte: {
        effecti: raw.contagens?.porFonte?.effecti ?? 0,
        nomus: raw.contagens?.porFonte?.nomus ?? 0,
        gmail: raw.contagens?.porFonte?.gmail ?? 0,
        drive: raw.contagens?.porFonte?.drive ?? 0,
      },
      porStatus: {
        pendente: raw.contagens?.porStatus?.pendente ?? 0,
        extraido: raw.contagens?.porStatus?.extraido ?? 0,
        herdado: raw.contagens?.porStatus?.herdado ?? 0,
        erro: raw.contagens?.porStatus?.erro ?? 0,
        precisa_ocr: raw.contagens?.porStatus?.precisa_ocr ?? 0,
        inobtenivel: raw.contagens?.porStatus?.inobtenivel ?? 0,
        ignorado: raw.contagens?.porStatus?.ignorado ?? 0,
      },
      total: raw.contagens?.total ?? 0,
    },
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
