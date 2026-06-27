// =====================================================================
// engines/widgets.ts — engine dos Paineis fixos do cockpit (delta-17).
//
// Caso particular do makeScopeConfig para `tipo='widget'` (mapa-sinais,
// saude-cockpit, atalhos-operacionais). Mesma semantica de visibilidade/ordem/
// banda/valor do engine generico.
// =====================================================================

import { makeScopeConfig, type ScopeConfig } from "@/lib/engines/block-vis";
import type { BlocoConfig } from "@/types/domain";

/** Engine dos Paineis fixos do cockpit (tipo `widget`). */
export function makeWidgetsConfig(entries: readonly BlocoConfig[]): ScopeConfig {
  return makeScopeConfig("widget", entries);
}
