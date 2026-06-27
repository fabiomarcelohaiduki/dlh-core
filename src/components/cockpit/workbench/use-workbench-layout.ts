"use client";

// =====================================================================
// use-workbench-layout — resolucao de blocos/bandas do WorkbenchTemplate
// sobre `bloco_config` (delta-08..12, delta-19).
//
// Resolve, para um escopo de workbench `<modulo>/<tela>/<guia>`:
//   - VISIBILIDADE com cascata guia > submodulo > modulo > global (delta-10);
//   - ORDEM HORIZONTAL por banda/zona (delta-11);
//   - ORDEM VERTICAL das bandas reordenaveis topo/status/ferramentas (delta-12).
//
// As escritas do workbench persistem no nivel mais especifico (guia) via
// `bloco_config` tipo 'bloco' (delta-19), com aplicacao OTIMISTA local e
// rollback em falha (EC-14). A configuracao do submodulo (block-matrix em
// "Configuracoes do modulo") permanece visivel pela cascata quando o guia
// nao sobrescreve.
// =====================================================================

import { useCallback, useMemo, useState } from "react";
import { makeScopeConfig } from "@/lib/engines/block-vis";
import { useBlocoConfig, useUpsertBlocoConfig } from "@/hooks/use-configuracao";
import type { BlocoConfigUpsertInput } from "@/lib/api/bloco-config";
import type { BlocoBanda } from "@/types/database";

/** Blocos presos a tabela (column:true): nunca reordenam horizontalmente. */
export const COLUMN_BLOCKS: ReadonlySet<string> = new Set(["lote", "acoes-linha"]);

/** Bandas reordenaveis verticalmente entre o cabecalho e a tabela (delta-12). */
export const REORDERABLE_BANDS: readonly BlocoBanda[] = [
  "topo",
  "status",
  "ferramentas",
];

/** Override otimista local de uma entrada de bloco_config. */
interface Override {
  visivel?: boolean;
  ordem?: number;
  banda?: BlocoBanda | null;
}

export interface WorkbenchScopeRef {
  /** Modulo canonico (ingestao/cadastros/automacoes). */
  modulo: string;
  /** Tela/submodulo (ex.: coleta). */
  tela: string;
  /** Guia/subpane ativa (ex.: execucoes, dados). */
  guia: string;
}

/** Notificador de feedback (toast efemero) do workbench. */
export type WorkbenchNotify = (kind: "ok" | "err", message: string) => void;

/** Constroi o escopo pontilhado de um nivel da cascata. */
function levelDot(ref: WorkbenchScopeRef, level: 0 | 1 | 2 | 3): string {
  switch (level) {
    case 0:
      return `${ref.modulo}.${ref.tela}.${ref.guia}`; // guia (mais especifico)
    case 1:
      return `${ref.modulo}.${ref.tela}`; // submodulo
    case 2:
      return ref.modulo; // modulo
    default:
      return ""; // global
  }
}

/** Escopo de um bloco num dado nivel; nivel global usa o id puro. */
function blockEscopoAt(prefix: string, blockId: string): string {
  return prefix ? `${prefix}.${blockId}` : blockId;
}

/** Pseudo-escopo da banda (ordem vertical), no nivel da guia. */
function bandEscopo(ref: WorkbenchScopeRef, banda: BlocoBanda): string {
  return `${levelDot(ref, 0)}.__band.${banda}`;
}

export interface WorkbenchLayout {
  isLoading: boolean;
  /** True enquanto o modo de personalizacao estiver ativo. */
  customizing: boolean;
  setCustomizing: (on: boolean) => void;
  /** Visibilidade resolvida do bloco (cascata + override otimista). */
  isVisible: (blockId: string) => boolean;
  /** Ordem horizontal resolvida do bloco dentro da banda. */
  ordemOf: (blockId: string, fallback: number) => number;
  /** Banda resolvida do bloco (override > config > default). */
  bandaOf: (blockId: string, fallback: BlocoBanda) => BlocoBanda;
  /** Ordem vertical resolvida das bandas reordenaveis. */
  bandOrder: () => BlocoBanda[];
  /** Liga/desliga a visibilidade do bloco (persistido no nivel da guia). */
  setVisible: (blockId: string, on: boolean) => void;
  /** Move o bloco dentro da sua banda (reordena os irmaos visiveis). */
  moveBlock: (
    blockId: string,
    siblingsInOrder: readonly string[],
    dir: -1 | 1,
  ) => void;
  /** Move uma banda reordenavel para cima/baixo (swap). */
  moveBand: (banda: BlocoBanda, dir: -1 | 1) => void;
}

export function useWorkbenchLayout(
  ref: WorkbenchScopeRef,
  notify: WorkbenchNotify,
): WorkbenchLayout {
  const { data: blocos, isLoading } = useBlocoConfig(undefined, "bloco");
  const upsert = useUpsertBlocoConfig();
  const [customizing, setCustomizing] = useState(false);
  const [overrides, setOverrides] = useState<Map<string, Override>>(
    () => new Map(),
  );

  const cfg = useMemo(
    () => makeScopeConfig("bloco", blocos ?? []),
    [blocos],
  );

  // ---- Leitura com override otimista por cima do snapshot do servidor ----

  const readEntry = useCallback(
    (escopo: string): Override | undefined => {
      const ov = overrides.get(escopo);
      const server = cfg.get(escopo);
      if (!ov && !server) return undefined;
      return {
        visivel: ov?.visivel ?? server?.visivel,
        ordem: ov?.ordem ?? server?.ordem,
        banda: ov?.banda ?? server?.banda ?? null,
      };
    },
    [overrides, cfg],
  );

  const isVisible = useCallback(
    (blockId: string): boolean => {
      // Cascata: guia > submodulo > modulo > global; primeiro nivel definido vence.
      for (let level = 0 as 0 | 1 | 2 | 3; level <= 3; level++) {
        const escopo = blockEscopoAt(levelDot(ref, level), blockId);
        const e = readEntry(escopo);
        if (e && e.visivel !== undefined) return e.visivel;
      }
      return true; // default honesto: visivel quando nunca configurado.
    },
    [ref, readEntry],
  );

  const ordemOf = useCallback(
    (blockId: string, fallback: number): number => {
      for (let level = 0 as 0 | 1 | 2 | 3; level <= 3; level++) {
        const escopo = blockEscopoAt(levelDot(ref, level), blockId);
        const e = readEntry(escopo);
        if (e && e.ordem !== undefined) return e.ordem;
      }
      return fallback;
    },
    [ref, readEntry],
  );

  const bandaOf = useCallback(
    (blockId: string, fallback: BlocoBanda): BlocoBanda => {
      for (let level = 0 as 0 | 1 | 2 | 3; level <= 3; level++) {
        const escopo = blockEscopoAt(levelDot(ref, level), blockId);
        const e = readEntry(escopo);
        if (e && e.banda) return e.banda;
      }
      return fallback;
    },
    [ref, readEntry],
  );

  const bandOrder = useCallback((): BlocoBanda[] => {
    return REORDERABLE_BANDS.map((banda, idx) => {
      const e = readEntry(bandEscopo(ref, banda));
      return { banda, ordem: e?.ordem ?? idx, idx };
    })
      .sort((a, b) => a.ordem - b.ordem || a.idx - b.idx)
      .map((x) => x.banda);
  }, [ref, readEntry]);

  // ---- Escrita otimista com rollback (EC-14) ----

  const commit = useCallback(
    (items: BlocoConfigUpsertInput[]) => {
      if (items.length === 0) return;
      // Snapshot dos overrides anteriores apenas para os escopos tocados.
      const prevSlice = new Map<string, Override | undefined>();
      setOverrides((prev) => {
        const next = new Map(prev);
        for (const it of items) {
          prevSlice.set(it.escopo, prev.get(it.escopo));
          const merged: Override = { ...(prev.get(it.escopo) ?? {}) };
          if (it.visivel !== undefined) merged.visivel = it.visivel;
          if (it.ordem !== undefined) merged.ordem = it.ordem;
          if (it.banda !== undefined) merged.banda = it.banda;
          next.set(it.escopo, merged);
        }
        return next;
      });

      upsert.mutate(items, {
        onSuccess: () => notify("ok", "Layout salvo."),
        onError: () => {
          // Rollback otimista: restaura os overrides anteriores dos escopos tocados.
          setOverrides((prev) => {
            const next = new Map(prev);
            for (const [escopo, before] of prevSlice) {
              if (before === undefined) next.delete(escopo);
              else next.set(escopo, before);
            }
            return next;
          });
          notify("err", "Não foi possível salvar. Tente novamente.");
        },
      });
    },
    [upsert, notify],
  );

  const setVisible = useCallback(
    (blockId: string, on: boolean) => {
      commit([
        { escopo: blockEscopoAt(levelDot(ref, 0), blockId), tipo: "bloco", visivel: on },
      ]);
    },
    [ref, commit],
  );

  const moveBlock = useCallback(
    (blockId: string, siblingsInOrder: readonly string[], dir: -1 | 1) => {
      if (COLUMN_BLOCKS.has(blockId)) return; // blocos column nao reordenam.
      const idx = siblingsInOrder.indexOf(blockId);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= siblingsInOrder.length) return;
      const reordered = [...siblingsInOrder];
      const [moved] = reordered.splice(idx, 1);
      reordered.splice(target, 0, moved);
      commit(
        reordered.map((id, i) => ({
          escopo: blockEscopoAt(levelDot(ref, 0), id),
          tipo: "bloco" as const,
          ordem: i,
        })),
      );
    },
    [ref, commit],
  );

  const moveBand = useCallback(
    (banda: BlocoBanda, dir: -1 | 1) => {
      const order = bandOrder();
      const idx = order.indexOf(banda);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= order.length) return;
      const reordered = [...order];
      const [moved] = reordered.splice(idx, 1);
      reordered.splice(target, 0, moved);
      commit(
        reordered.map((b, i) => ({
          escopo: bandEscopo(ref, b),
          tipo: "bloco" as const,
          ordem: i,
        })),
      );
    },
    [ref, bandOrder, commit],
  );

  return {
    isLoading,
    customizing,
    setCustomizing,
    isVisible,
    ordemOf,
    bandaOf,
    bandOrder,
    setVisible,
    moveBlock,
    moveBand,
  };
}
