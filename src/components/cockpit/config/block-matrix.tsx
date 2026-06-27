"use client";

// =====================================================================
// block-matrix — matriz de blocos por tela de um modulo (delta-18/19).
//
// Componente reutilizavel que lista os blocos de layout de cada tela de um
// modulo, agrupados pela banda resolvida, com controles de:
//   - visibilidade (cc-toggle)        -> visivel
//   - ordem dentro da banda (setas)   -> ordem
//   - banda de destino (cc-select)    -> banda
//
// Alimentado por `makeScopeConfig("bloco", ...)` sobre o snapshot de
// `bloco_config`. Persistencia AO VIVO (sem botao Salvar): cada alteracao
// dispara um upsert em lote e exibe um toast efemero. O escopo canonico de
// cada bloco e `<modulo>.<tela>.<bloco>` (blockEscopo).
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, TriangleAlert } from "lucide-react";
import {
  BAND_LABELS,
  BAND_ORDER,
  BLOCK_DEF,
  MODULE_CONFIGS,
  blockEscopo,
  type ModuloId,
} from "@/lib/cockpit-config";
import { makeScopeConfig } from "@/lib/engines/block-vis";
import { useBlocoConfig, useUpsertBlocoConfig } from "@/hooks/use-configuracao";
import type { BlocoConfigUpsertInput } from "@/lib/api/bloco-config";
import type { BlocoBanda } from "@/types/database";
import { EmptyState } from "@/components/cockpit/ui/empty-state";
import { CcRow } from "./cc-row";
import { CcToggle } from "./cc-toggle";
import { CcSelect, type CcSelectOption } from "./cc-select";

/** Item resolvido de um bloco dentro de uma banda. */
interface BlockItem {
  blockId: string;
  escopo: string;
  label: string;
  desc: string;
  ordem: number;
  catalogIndex: number;
}

/** Opcoes do seletor de banda (ordem canonica BAND_ORDER). */
const BAND_OPTS: ReadonlyArray<CcSelectOption<BlocoBanda>> = BAND_ORDER.map(
  (b) => ({ value: b, label: BAND_LABELS[b] }),
);

type Toast = { kind: "ok" | "err"; message: string };

export function BlockMatrix({ modulo }: { modulo: ModuloId }) {
  const { data: blocos, isLoading } = useBlocoConfig(undefined, "bloco");
  const upsert = useUpsertBlocoConfig();
  const [toast, setToast] = useState<Toast | null>(null);

  // Auto-dismiss do toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const cfg = useMemo(
    () => makeScopeConfig("bloco", blocos ?? []),
    [blocos],
  );

  const moduleConfig = MODULE_CONFIGS[modulo];

  // Resolve, por tela, os blocos agrupados pela banda (override ?? default).
  // Telas sem blocos validos ficam com `byBand` vazio; o modulo so tem blocos
  // se ao menos uma tela renderizar algo.
  const screens = useMemo(() => {
    return moduleConfig.screens.map((screen) => {
      const byBand = new Map<BlocoBanda, BlockItem[]>();
      screen.blocks.forEach((blockId, catalogIndex) => {
        const def = BLOCK_DEF[blockId];
        if (!def) return;
        const escopo = blockEscopo(modulo, screen.id, blockId);
        const banda = cfg.bandaOf(escopo) ?? def.banda;
        const ordem = cfg.ordemOf(escopo, catalogIndex);
        const list = byBand.get(banda) ?? [];
        list.push({
          blockId,
          escopo,
          label: def.label,
          desc: def.desc,
          ordem,
          catalogIndex,
        });
        byBand.set(banda, list);
      });
      for (const list of byBand.values()) {
        list.sort(
          (a, b) => a.ordem - b.ordem || a.catalogIndex - b.catalogIndex,
        );
      }
      return { screen, byBand };
    });
  }, [moduleConfig, modulo, cfg]);

  const hasAnyBlocks = screens.some(({ byBand }) => byBand.size > 0);

  /** Persistencia ao vivo: dispara o upsert em lote + toast. No-op se vazio. */
  function commit(items: BlocoConfigUpsertInput[]) {
    if (items.length === 0) return;
    upsert.mutate(items, {
      onSuccess: () => setToast({ kind: "ok", message: "Layout salvo." }),
      onError: () =>
        setToast({
          kind: "err",
          message: "Não foi possível salvar. Tente novamente.",
        }),
    });
  }

  if (isLoading) {
    return (
      <div className="block-matrix" data-block-matrix={modulo} aria-busy="true">
        <p className="bm-loading">Carregando blocos…</p>
      </div>
    );
  }

  return (
    <div className="block-matrix" data-block-matrix={modulo}>
      {!hasAnyBlocks ? (
        // Estado vazio honesto: modulo sem nenhuma tela com blocos de layout
        // (ex.: Automacoes, que so expoe "Configuracoes do modulo").
        <EmptyState
          className="bm-empty"
          message="Nenhum bloco para organizar neste módulo"
          hint="Este módulo não possui telas com blocos de layout configuráveis."
        />
      ) : (
        screens.map(({ screen, byBand }) => (
          <section key={screen.id} className="bm-screen" aria-label={screen.label}>
            <p className="cc-grouptitle">{screen.label}</p>
            {byBand.size === 0 ? (
              // Estado vazio honesto por tela: tela listada porem sem blocos.
              <EmptyState
                className="bm-empty"
                message="Nenhum bloco nesta tela"
                hint="Esta tela ainda não tem blocos de layout configuráveis."
              />
            ) : (
              BAND_ORDER.filter((band) => byBand.has(band)).map((band) => {
                const list = byBand.get(band) ?? [];
                return (
                  <div key={band} className="bm-band">
                    <div className="bm-band-head">{BAND_LABELS[band]}</div>
                    {list.map((item, pos) => (
                      <CcRow
                        key={item.escopo}
                        title={item.label}
                        description={item.desc}
                        controls={
                          <span className="bm-controls">
                            <span className="bm-order" role="group" aria-label="Ordem do bloco">
                              <button
                                type="button"
                                className="bm-arrow"
                                aria-label={`Mover ${item.label} para cima`}
                                disabled={pos === 0}
                                onClick={() => commit(moveWithinBand(list, item.escopo, -1))}
                              >
                                <ArrowUp aria-hidden="true" width={14} height={14} />
                              </button>
                              <button
                                type="button"
                                className="bm-arrow"
                                aria-label={`Mover ${item.label} para baixo`}
                                disabled={pos === list.length - 1}
                                onClick={() => commit(moveWithinBand(list, item.escopo, 1))}
                              >
                                <ArrowDown aria-hidden="true" width={14} height={14} />
                              </button>
                            </span>
                            <CcSelect
                              ariaLabel={`Banda do bloco ${item.label}`}
                              value={band}
                              options={BAND_OPTS}
                              onChange={(next) =>
                                commit(changeBand(byBand, item.escopo, band, next))
                              }
                            />
                            <CcToggle
                              ariaLabel={`Exibir bloco ${item.label}`}
                              checked={cfg.isOn(item.escopo)}
                              onChange={(on) =>
                                commit([
                                  { escopo: item.escopo, tipo: "bloco", visivel: on },
                                ])
                              }
                            />
                          </span>
                        }
                      />
                    ))}
                  </div>
                );
              })
            )}
          </section>
        ))
      )}

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className={`cfg-toast ${toast.kind === "err" ? "is-err" : "is-ok"}`}
        >
          {toast.kind === "err" ? (
            <TriangleAlert aria-hidden="true" width={16} height={16} />
          ) : (
            <Check aria-hidden="true" width={16} height={16} />
          )}
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Reordena um item dentro da banda e reatribui ordem sequencial (0..n-1) a
 * todos os blocos da banda, garantindo estabilidade. `dir` = -1 (cima) / +1
 * (baixo). Retorna a lista de upserts a persistir (vazia se fora dos limites).
 */
function moveWithinBand(
  list: readonly BlockItem[],
  escopo: string,
  dir: -1 | 1,
): BlocoConfigUpsertInput[] {
  const idx = list.findIndex((i) => i.escopo === escopo);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= list.length) return [];
  const reordered = [...list];
  const [moved] = reordered.splice(idx, 1);
  reordered.splice(target, 0, moved);
  return reordered.map((item, i) => ({
    escopo: item.escopo,
    tipo: "bloco" as const,
    ordem: i,
  }));
}

/**
 * Move um bloco para outra banda, posicionando-o no fim da banda de destino
 * (ordem = maior ordem atual + 1). Persiste banda + ordem num unico upsert.
 */
function changeBand(
  byBand: ReadonlyMap<BlocoBanda, BlockItem[]>,
  escopo: string,
  current: BlocoBanda,
  next: BlocoBanda,
): BlocoConfigUpsertInput[] {
  if (next === current) return [];
  const targetList = byBand.get(next) ?? [];
  const maxOrdem = targetList.reduce((m, i) => Math.max(m, i.ordem), -1);
  return [
    { escopo, tipo: "bloco", banda: next, ordem: maxOrdem + 1 },
  ];
}
