import { apiFetch } from "@/lib/api/client";
import type { ConfigIndexacaoState, FonteIndexacao, IndexacaoResumo } from "@/lib/api/types";

// ---------------------------------------------------------------------
// Cliente do Edge `indexacao` (painel da INDEXACAO / embeddings).
//   - salvarConfigIndexacao: PUT do singleton config_indexacao (master
//     switch, fontes, orcamento, pausa). A LEITURA e hidratada server-side
//     (RLS) na pagina Indexacao; aqui fica so a ESCRITA.
//   - fetchIndexacaoResumo: POST { action:"resumo" } -> contagens por status
//     (vem do service_role; count direto pelo browser e fragil por RLS).
//   - dispararIndexacao: POST { action:"disparar" } -> aciona 1 lote de
//     backfill (auto-encadeado). So gasta quando o master switch esta ON.
// Contrato em camelCase; o Edge mapeia para snake e valida.
// ---------------------------------------------------------------------

/** Payload (camel) do PUT /indexacao — substitui a config inteira. */
export type SalvarConfigIndexacaoInput = ConfigIndexacaoState;

/**
 * PUT /indexacao — persiste a config da indexacao (embeddings). Vale na
 * PROXIMA invocacao do backfill e no proximo push do continuo; nao afeta um
 * lote em andamento.
 */
export function salvarConfigIndexacao(
  input: SalvarConfigIndexacaoInput,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("indexacao", {
    method: "PUT",
    body: JSON.stringify({
      ativo: input.ativo,
      processosAtivo: input.processosAtivo,
      fontesHabilitadas: input.fontesHabilitadas,
      loteChunks: input.loteChunks,
      pausaMs: input.pausaMs,
      tpmAlvo: input.tpmAlvo,
      tentativasMax: input.tentativasMax,
      embeddingsProvider: input.embeddingsProvider,
      embeddingsEndpoint: input.embeddingsEndpoint,
    }),
  });
}

interface IndexacaoResumoRaw {
  contagens?: {
    pendente?: number;
    em_andamento?: number;
    concluida?: number;
    erro?: number;
    total?: number;
  };
}

/**
 * POST /indexacao { action:"resumo" } — contagens por status_indexacao das
 * fontes informadas (ausente/null = todas). Alimenta o progresso do painel.
 */
export function fetchIndexacaoResumo(
  fontes?: FonteIndexacao[] | null,
): Promise<IndexacaoResumo> {
  const body: Record<string, unknown> = { action: "resumo" };
  if (fontes && fontes.length > 0) body.fontes = fontes;
  return apiFetch<IndexacaoResumoRaw>("indexacao", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((raw) => ({
    pendente: raw.contagens?.pendente ?? 0,
    emAndamento: raw.contagens?.em_andamento ?? 0,
    concluida: raw.contagens?.concluida ?? 0,
    erro: raw.contagens?.erro ?? 0,
    total: raw.contagens?.total ?? 0,
  }));
}

/**
 * POST /indexacao { action:"disparar" } — aciona 1 lote de backfill da
 * indexacao AGORA (auto-encadeado ate esgotar a fila). So tem efeito quando o
 * master switch (ativo) esta ON; OFF => no-op no documentos-indexar.
 */
export function dispararIndexacao(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("indexacao", {
    method: "POST",
    body: JSON.stringify({ action: "disparar" }),
  });
}

/**
 * POST /indexacao { action:"reprocessar_erros", fontes? } — move os documentos
 * em status_indexacao=erro de volta para pendente (filtrado pela[s] fonte[s]
 * indexada[s]) e reabre o backfill. Retry idempotente (erros de backfill sao
 * transitorios; chunks inseridos atomicamente no fim do doc). So gasta quando o
 * master switch (ativo) esta ON. Devolve a quantidade reenfileirada.
 */
export function reprocessarErrosIndexacao(
  fontes?: FonteIndexacao[] | null,
): Promise<{ ok: boolean; reenfileirados: number }> {
  const body: Record<string, unknown> = { action: "reprocessar_erros" };
  if (fontes && fontes.length > 0) body.fontes = fontes;
  return apiFetch<{ ok: boolean; reenfileirados?: number }>("indexacao", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((raw) => ({ ok: raw.ok, reenfileirados: raw.reenfileirados ?? 0 }));
}
