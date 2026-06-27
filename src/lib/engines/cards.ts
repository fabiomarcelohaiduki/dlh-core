// =====================================================================
// engines/cards.ts — engine dos Cards do cockpit (delta-16).
//
// Caso particular do makeScopeConfig para `tipo='card'`. A visibilidade de um
// card e governada por `cardsCfg.setOn(escopo, false)` (SPEC 4.5, estado
// `card-hidden`); a ordem e a metrica selecionada (`valor`) seguem o mesmo
// contrato do engine generico.
// =====================================================================

import { makeScopeConfig, type ScopeConfig } from "@/lib/engines/block-vis";
import type { BlocoConfig } from "@/types/domain";

/** Engine dos Cards do cockpit (tipo `card`). */
export function makeCardsConfig(entries: readonly BlocoConfig[]): ScopeConfig {
  return makeScopeConfig("card", entries);
}
