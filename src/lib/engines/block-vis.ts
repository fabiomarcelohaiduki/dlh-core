// =====================================================================
// engines/block-vis.ts — makeScopeConfig (delta-18/19).
//
// Engine puro (sem I/O) de visibilidade/ordem/banda por escopo hierarquico,
// operando sobre um snapshot de `bloco_config` de um unico `tipo`
// (bloco/card/widget). As leituras refletem o snapshot; as escritas produzem
// um `ScopeUpsert` (a ser persistido por `upsertBlocoConfigLote`) e atualizam
// o snapshot interno para coerencia otimista.
//
// Cards/widgets sao casos particulares deste engine (ver cards.ts / widgets.ts).
// =====================================================================

import type { BlocoBanda, BlocoTipo } from "@/types/database";
import type { BlocoConfig } from "@/types/domain";

/** Patch a persistir resultante de uma escrita no engine. */
export interface ScopeUpsert {
  escopo: string;
  tipo: BlocoTipo;
  visivel?: boolean;
  ordem?: number;
  banda?: BlocoBanda | null;
  valor?: Record<string, unknown> | null;
}

/** Acessor de configuracao por escopo de um unico `tipo`. */
export interface ScopeConfig {
  readonly tipo: BlocoTipo;
  /** Snapshot atual (apenas entradas do `tipo`). */
  entries(): BlocoConfig[];
  get(escopo: string): BlocoConfig | undefined;
  /** Visibilidade do escopo; `fallback` (default true) quando ausente. */
  isOn(escopo: string, fallback?: boolean): boolean;
  /** Ordem do escopo; `fallback` (default 0) quando ausente. */
  ordemOf(escopo: string, fallback?: number): number;
  bandaOf(escopo: string): BlocoBanda | null;
  valorOf(escopo: string): Record<string, unknown> | null;
  /** Descendentes hierarquicos de `prefixo` (escopo que comeca com `prefixo.`). */
  childrenOf(prefixo: string): BlocoConfig[];
  setOn(escopo: string, on: boolean): ScopeUpsert;
  setOrdem(escopo: string, ordem: number): ScopeUpsert;
  setBanda(escopo: string, banda: BlocoBanda | null): ScopeUpsert;
  setValor(escopo: string, valor: Record<string, unknown> | null): ScopeUpsert;
  /** Entradas cujo escopo nao pertence ao catalogo canonico (orfaos). */
  orphans(validEscopos: Iterable<string>): BlocoConfig[];
}

/** Sintetiza uma entrada minima para escopos ainda nao persistidos. */
function entradaSintetica(escopo: string, tipo: BlocoTipo): BlocoConfig {
  return {
    id: "",
    userId: "",
    orgId: "",
    escopo,
    tipo,
    visivel: true,
    ordem: 0,
    banda: null,
    valor: null,
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * Cria um acessor de configuracao por escopo para um `tipo` especifico.
 * Filtra o snapshot por `tipo`; entradas de outros tipos sao ignoradas.
 */
export function makeScopeConfig(
  tipo: BlocoTipo,
  entries: readonly BlocoConfig[],
): ScopeConfig {
  const map = new Map<string, BlocoConfig>();
  for (const e of entries) {
    if (e.tipo === tipo) map.set(e.escopo, e);
  }

  function upsertSnapshot(escopo: string, patch: Partial<BlocoConfig>): void {
    const atual = map.get(escopo) ?? entradaSintetica(escopo, tipo);
    map.set(escopo, { ...atual, ...patch });
  }

  return {
    tipo,
    entries() {
      return [...map.values()];
    },
    get(escopo) {
      return map.get(escopo);
    },
    isOn(escopo, fallback = true) {
      const e = map.get(escopo);
      return e ? e.visivel : fallback;
    },
    ordemOf(escopo, fallback = 0) {
      const e = map.get(escopo);
      return e ? e.ordem : fallback;
    },
    bandaOf(escopo) {
      return map.get(escopo)?.banda ?? null;
    },
    valorOf(escopo) {
      return map.get(escopo)?.valor ?? null;
    },
    childrenOf(prefixo) {
      const p = `${prefixo}.`;
      return [...map.values()].filter((e) => e.escopo.startsWith(p));
    },
    setOn(escopo, on) {
      upsertSnapshot(escopo, { visivel: on });
      return { escopo, tipo, visivel: on };
    },
    setOrdem(escopo, ordem) {
      upsertSnapshot(escopo, { ordem });
      return { escopo, tipo, ordem };
    },
    setBanda(escopo, banda) {
      upsertSnapshot(escopo, { banda });
      return { escopo, tipo, banda };
    },
    setValor(escopo, valor) {
      upsertSnapshot(escopo, { valor });
      return { escopo, tipo, valor };
    },
    orphans(validEscopos) {
      const valid = new Set(validEscopos);
      return [...map.values()].filter((e) => !valid.has(e.escopo));
    },
  };
}

/** Conveniencia: engine de blocos por tela (tipo `bloco`). */
export function makeBlockConfig(entries: readonly BlocoConfig[]): ScopeConfig {
  return makeScopeConfig("bloco", entries);
}

/**
 * Extrai o id selecionado de um `valor` jsonb no formato `{ value: string }`,
 * usado para persistir a metrica de um card / o dado de um painel fixo. Retorna
 * `undefined` quando ausente ou em formato inesperado (cai no default do motor).
 */
export function scopeValueId(
  valor: Record<string, unknown> | null,
): string | undefined {
  if (valor && typeof valor.value === "string") return valor.value;
  return undefined;
}
