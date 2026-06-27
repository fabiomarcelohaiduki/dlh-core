// =====================================================================
// _shared/block-registry.ts
// Registry injetavel dos adapters de fonte coletavel em blocos (§5.4).
//
// Espelha o FORMATO de createConnector (mapa tipo -> factory), mas e um seam
// SEPARADO: nao reusa createConnector. O orquestrador resolve o adapter por
// `fontes.tipo` tratando-o como BlockSourceAdapter<unknown> (type-erasure do
// cursor — cada adapter declara seu TCursor por dentro).
//
// O mapa e PARAMETRO de resolveBlockAdapter, permitindo injetar um fake adapter
// em teste sem tocar no default.
// =====================================================================

import { type BlockSourceAdapter } from "./block-source.ts";
import { effectiBlockAdapter } from "./block-adapters/effecti-block-adapter.ts";

/** Mapa tipo-de-fonte -> adapter (cursor opaco ao seam). */
export type BlockAdapterMap = Record<string, BlockSourceAdapter<unknown>>;

/**
 * Adapters padrao por `fontes.tipo`. O cursor especifico de cada adapter
 * (EffectiCursor) e apagado para `unknown` na borda do registry (type-erasure):
 * o orquestrador nunca le o cursor, so o repassa.
 *
 * D1 (Effecti-only): o Nomus permanece na sua maquina de bloco propria
 * (nomus-pipeline.ts) e NAO e adotado pelo seam; fonte sem adapter aqui e
 * tratada como ociosa pelo orquestrador (resolveBlockAdapter -> null).
 */
export const DEFAULT_BLOCK_ADAPTERS: BlockAdapterMap = {
  effecti: effectiBlockAdapter as unknown as BlockSourceAdapter<unknown>,
};

/**
 * Resolve o adapter de bloco por tipo de fonte. Retorna null para tipo
 * desconhecido (o chamador decide o fallback). O mapa e injetavel para teste.
 */
export function resolveBlockAdapter(
  tipo: string,
  map: BlockAdapterMap = DEFAULT_BLOCK_ADAPTERS,
): BlockSourceAdapter<unknown> | null {
  return map[tipo] ?? null;
}
