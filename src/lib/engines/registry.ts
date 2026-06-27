// =====================================================================
// engines/registry.ts — ENGINES[] + runHook (coordenador dos engines).
//
// Centraliza os 3 engines de configuracao por escopo (blocos por tela, cards do
// cockpit, paineis fixos) e os instancia a partir de UM unico snapshot de
// `bloco_config`. `runHook` particiona o snapshot por `tipo` (cada engine ja
// filtra internamente) e expoe os acessores prontos, alem do calculo agregado
// de orfaos para o prune (SPEC 2.3.2).
// =====================================================================

import { makeScopeConfig, type ScopeConfig } from "@/lib/engines/block-vis";
import { makeCardsConfig } from "@/lib/engines/cards";
import { makeWidgetsConfig } from "@/lib/engines/widgets";
import type { BlocoTipo } from "@/types/database";
import type { BlocoConfig } from "@/types/domain";

/** Descritor de um engine registrado. */
export interface Engine {
  id: "blocos" | "cards" | "widgets";
  tipo: BlocoTipo;
  make(entries: readonly BlocoConfig[]): ScopeConfig;
}

/** Registro canonico dos engines de configuracao por escopo. */
export const ENGINES: readonly Engine[] = [
  { id: "blocos", tipo: "bloco", make: (e) => makeScopeConfig("bloco", e) },
  { id: "cards", tipo: "card", make: (e) => makeCardsConfig(e) },
  { id: "widgets", tipo: "widget", make: (e) => makeWidgetsConfig(e) },
];

/** Catalogo canonico de escopos validos por tipo (para o calculo de orfaos). */
export type CatalogoValido = Partial<Record<BlocoTipo, Iterable<string>>>;

/** Estado coordenado dos engines, derivado de um snapshot de bloco_config. */
export interface EnginesState {
  blocos: ScopeConfig;
  cards: ScopeConfig;
  widgets: ScopeConfig;
  /** Acesso ao engine por id. */
  byId(id: Engine["id"]): ScopeConfig;
  /** Entradas orfas (fora do catalogo) somando todos os engines. */
  orphans(valido: CatalogoValido): BlocoConfig[];
}

/**
 * Coordena os engines a partir de um unico snapshot de `bloco_config`.
 * Cada engine filtra o snapshot pelo proprio `tipo`, entao basta passar a
 * lista completa.
 */
export function runHook(all: readonly BlocoConfig[]): EnginesState {
  const built = new Map<Engine["id"], ScopeConfig>();
  for (const eng of ENGINES) {
    built.set(eng.id, eng.make(all));
  }

  const byId = (id: Engine["id"]): ScopeConfig => {
    const sc = built.get(id);
    if (!sc) throw new Error(`Engine desconhecido: ${id}`);
    return sc;
  };

  return {
    blocos: byId("blocos"),
    cards: byId("cards"),
    widgets: byId("widgets"),
    byId,
    orphans(valido) {
      const out: BlocoConfig[] = [];
      for (const eng of ENGINES) {
        const validos = valido[eng.tipo] ?? [];
        out.push(...byId(eng.id).orphans(validos));
      }
      return out;
    },
  };
}
