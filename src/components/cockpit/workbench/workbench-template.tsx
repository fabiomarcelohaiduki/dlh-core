"use client";

// =====================================================================
// WorkbenchTemplate — padrao reutilizavel de tela operacional (delta-08/09).
//
// Renderiza um "workbench" parametrizavel por escopo/labels/blocos, reusado
// pelas views de Ingestao (coleta/extracao/indexacao) e Cadastros. Os blocos
// (data-block) sao posicionados por banda (data-band) e respeitam:
//   - visibilidade em cascata (guia>submodulo>modulo>global) — delta-10;
//   - ordem horizontal por zona — delta-11;
//   - ordem vertical das bandas topo/status/ferramentas — delta-12.
//
// O modo "Personalizar" expoe os controles de reordenacao/visibilidade que
// persistem AO VIVO em bloco_config (delta-19) com rollback otimista (EC-14).
// Acoes operacionais sao read-only por decisao (Conflito 04 / delta-28/29).
// =====================================================================

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, Settings2 } from "lucide-react";
import { BLOCK_DEF, BAND_LABELS } from "@/lib/cockpit-config";
import type { BlocoBanda } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { CcToggle } from "@/components/cockpit/config/cc-toggle";
import {
  COLUMN_BLOCKS,
  useWorkbenchLayout,
  type WorkbenchScopeRef,
} from "./use-workbench-layout";
import { CockpitToast } from "./cockpit-toast";

/** Slots de conteudo por bloco (o template injeta o "miolo" de cada bloco). */
export interface WorkbenchSlots {
  fontes?: ReactNode;
  recurso?: ReactNode;
  busca?: ReactNode;
  filtros?: ReactNode;
  /** Conteudo do bloco tempo-real; default = bandeira "Tempo real ativo". */
  tempoReal?: ReactNode;
  /** Barra de selecao em lote (bloco `lote`, banda tabela). */
  lote?: ReactNode;
}

export interface WorkbenchTemplateProps {
  /** Referencia de escopo (modulo/tela/guia) para a cascata e a persistencia. */
  scope: WorkbenchScopeRef;
  /** Valor de data-workbench (ex.: "coleta"). */
  workbenchKey: string;
  /** Titulo do cabecalho. Omitido quando ja existe uma aba com o mesmo rotulo. */
  title?: string;
  /** Texto descritivo opcional. Views com aba no cabecalho (ex.: coleta) o omitem. */
  description?: string;
  /** Pill de contagem opcional no cabecalho (ex.: "12 produtos"). */
  countLabel?: ReactNode;
  /**
   * Rotulo da acao principal ("Coletar agora"/...). Opcional: views sem o bloco
   * `acao-principal` nao renderizam o botao e podem omiti-lo.
   */
  actionLabel?: string;
  /** Acao principal (read-only por padrao: apenas leitura). */
  onAction?: () => void;
  /** Tooltip do botao de acao. Default "Apenas leitura" (views read-only). */
  actionTitle?: string;
  /** Desabilita o botao de acao (ex.: enquanto a coleta dispara). */
  actionDisabled?: boolean;
  /** Lista de blocos aplicaveis a esta view (ids do BLOCK_LIBRARY). */
  blocks: readonly string[];
  slots: WorkbenchSlots;
  /** Posicao do toast (default bottom-6); empilha quando a view tem outro toast. */
  toastClassName?: string;
  /** Regiao da tabela (RunsTable/DadosTable). */
  children: ReactNode;
}

/** Contexto para descendentes (tabela/lote) lerem a visibilidade resolvida. */
interface WorkbenchContextValue {
  isVisible: (blockId: string) => boolean;
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

/** Hook de descendentes do WorkbenchTemplate (ex.: ocultar coluna de acoes). */
export function useWorkbench(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) {
    throw new Error("useWorkbench deve ser usado dentro de <WorkbenchTemplate>.");
  }
  return ctx;
}

type Toast = { kind: "ok" | "err"; message: string };

/** Blocos fixos por zona: nao entram na regiao reordenavel do meio. */
const HEADER_BLOCK = "acao-principal";

export function WorkbenchTemplate({
  scope,
  workbenchKey,
  title,
  description,
  countLabel,
  actionLabel,
  onAction,
  actionTitle,
  actionDisabled,
  blocks,
  slots,
  toastClassName,
  children,
}: WorkbenchTemplateProps) {
  const [toast, setToast] = useState<Toast | null>(null);
  const layout = useWorkbenchLayout(scope, (kind, message) =>
    setToast({ kind, message }),
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const scopePath = `${scope.modulo}/${scope.tela}/${scope.guia}`;
  const blockSet = useMemo(() => new Set(blocks), [blocks]);

  // Conteudo renderizado de cada bloco "miolo".
  const slotFor = (blockId: string): ReactNode => {
    switch (blockId) {
      case "fontes":
        return slots.fontes ?? null;
      case "recurso":
        return slots.recurso ?? null;
      case "busca":
        return slots.busca ?? null;
      case "filtros":
        return slots.filtros ?? null;
      case "tempo-real":
        return (
          slots.tempoReal ?? (
            <span className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-muted">
              <span
                aria-hidden="true"
                className="size-2 animate-pulse rounded-full bg-ok"
              />
              Tempo real ativo
            </span>
          )
        );
      default:
        return null;
    }
  };

  // Agrupa os blocos do meio (exclui acao-principal e blocos column) por banda.
  const middleBlocks = blocks.filter(
    (id) => id !== HEADER_BLOCK && !COLUMN_BLOCKS.has(id),
  );

  const byBand = new Map<BlocoBanda, string[]>();
  middleBlocks.forEach((id) => {
    const def = BLOCK_DEF[id];
    if (!def) return;
    const banda = layout.bandaOf(id, def.banda);
    const list = byBand.get(banda) ?? [];
    list.push(id);
    byBand.set(banda, list);
  });
  // Ordena cada banda pela ordem horizontal resolvida (estavel pelo catalogo).
  for (const [banda, list] of byBand) {
    list.sort(
      (a, b) =>
        layout.ordemOf(a, middleBlocks.indexOf(a)) -
          layout.ordemOf(b, middleBlocks.indexOf(b)) ||
        middleBlocks.indexOf(a) - middleBlocks.indexOf(b),
    );
    byBand.set(banda, list);
  }

  const orderedBands = layout.bandOrder();
  // Descendentes (tabelas) so enxergam blocos declarados nesta tela: um bloco
  // fora do `blocks` nunca conta como visivel (alinha a coluna de selecao/acoes
  // a presenca real do bloco, nao so a cascata de config).
  const ctx: WorkbenchContextValue = {
    isVisible: (id: string) => blockSet.has(id) && layout.isVisible(id),
  };

  const actionVisible = blockSet.has(HEADER_BLOCK) && layout.isVisible(HEADER_BLOCK);
  const loteVisible = blockSet.has("lote") && layout.isVisible("lote");

  // A banda "topo" (abas de fonte + tempo real) vive DENTRO do cabecalho, na
  // mesma linha dos controles — espelha o prototipo (uma faixa unica). Views
  // sem banda topo mantem o titulo/descricao a esquerda. O bloco `recurso` e a
  // excecao: ocupa uma linha propria full-width da faixa (abaixo de tudo), por
  // isso e renderizado como filho direto da banda, fora do grupo esquerdo.
  const topoIds = (byBand.get("topo") ?? []).filter((id) => layout.isVisible(id));
  const inlineTopoIds = topoIds.filter((id) => id !== "recurso");
  const recursoVisible = topoIds.includes("recurso");

  return (
    <WorkbenchContext.Provider value={ctx}>
      <section
        data-workbench={workbenchKey}
        data-scope={scopePath}
        className="rounded-b-md rounded-t-none border border-border bg-surface shadow-[var(--shadow-card),var(--hairline-top)]"
      >
        {/* Banda de acao / cabecalho — faixa unica com as abas (banda topo) */}
        <div
          data-band="acao"
          className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-[color-mix(in_oklch,var(--bg)_45%,var(--surface))] px-[18px] py-1"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
            {title || description ? (
              <div className="min-w-0">
                {title ? (
                  <h3 className="text-[15px] font-bold tracking-[-0.01em] text-fg">
                    {title}
                  </h3>
                ) : null}
                {description ? (
                  <p className="max-w-[60ch] text-[13px] text-muted">{description}</p>
                ) : null}
              </div>
            ) : null}
            {inlineTopoIds.map((id) => (
              <div key={id} data-block={id} className="contents">
                {slotFor(id)}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {countLabel ? <Pill variant="neutral">{countLabel}</Pill> : null}
            <Button
              variant={layout.customizing ? "primary" : "default"}
              size="sm"
              type="button"
              aria-pressed={layout.customizing}
              onClick={() => layout.setCustomizing(!layout.customizing)}
            >
              <Settings2 aria-hidden="true" />
              Personalizar
            </Button>
            {actionVisible ? (
              <Button
                data-block="acao-principal"
                variant="primary"
                size="sm"
                type="button"
                onClick={onAction}
                disabled={actionDisabled}
                title={actionTitle ?? "Apenas leitura"}
              >
                {actionLabel}
              </Button>
            ) : null}
          </div>
          {/* Filtro de recurso: linha propria full-width abaixo das abas/controles. */}
          {recursoVisible ? (
            <div data-block="recurso" className="contents">
              {slotFor("recurso")}
            </div>
          ) : null}
        </div>

        {/* Painel de personalizacao (controles de ordem/visibilidade) */}
        {layout.customizing ? (
          <CustomizePanel
            orderedBands={orderedBands}
            byBand={byBand}
            blockSet={blockSet}
            layout={layout}
          />
        ) : null}

        {/* Bandas reordenaveis do meio (topo/status/ferramentas) */}
        {orderedBands.map((band) => {
          // A banda "topo" foi fundida no cabecalho (faixa unica); aqui so
          // renderizamos as demais bandas (status/ferramentas).
          if (band === "topo") return null;
          const ids = (byBand.get(band) ?? []).filter((id) => layout.isVisible(id));
          if (ids.length === 0) return null;
          const bandClass =
            "flex flex-wrap items-center gap-2.5 border-b border-border px-[18px] py-3";
          return (
            <div key={band} data-band={band} className={bandClass}>
              {ids.map((id) => (
                <div key={id} data-block={id} className="contents">
                  {slotFor(id)}
                </div>
              ))}
            </div>
          );
        })}

        {/* Banda da tabela: lote (selecao) + tabela */}
        <div data-band="tabela">
          {loteVisible ? <div data-block="lote">{slots.lote}</div> : null}
          {children}
        </div>
      </section>

      {toast ? (
        <CockpitToast
          kind={toast.kind}
          message={toast.message}
          className={toastClassName}
        />
      ) : null}
    </WorkbenchContext.Provider>
  );
}

/** Painel inline de personalizacao: ordem horizontal, vertical e visibilidade. */
function CustomizePanel({
  orderedBands,
  byBand,
  blockSet,
  layout,
}: {
  orderedBands: BlocoBanda[];
  byBand: Map<BlocoBanda, string[]>;
  blockSet: ReadonlySet<string>;
  layout: ReturnType<typeof useWorkbenchLayout>;
}) {
  return (
    <div className="grid gap-3 border-b border-border bg-surface-2 px-[18px] py-4">
      <p className="text-[11px] font-bold uppercase tracking-wide text-soft">
        Personalizar layout
      </p>
      {orderedBands.map((band, bandPos) => {
        const ids = (byBand.get(band) ?? []).filter((id) => blockSet.has(id));
        if (ids.length === 0) return null;
        const ordered = [...ids].sort(
          (a, b) => layout.ordemOf(a, 0) - layout.ordemOf(b, 0),
        );
        return (
          <div
            key={band}
            className="rounded-md border border-border bg-surface p-3"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-soft">
                {BAND_LABELS[band]}
              </span>
              <span className="inline-flex gap-1" role="group" aria-label="Ordem da banda">
                <Button
                  variant="icon"
                  size="sm"
                  type="button"
                  aria-label={`Mover banda ${BAND_LABELS[band]} para cima`}
                  disabled={bandPos === 0}
                  onClick={() => layout.moveBand(band, -1)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  variant="icon"
                  size="sm"
                  type="button"
                  aria-label={`Mover banda ${BAND_LABELS[band]} para baixo`}
                  disabled={bandPos === orderedBands.length - 1}
                  onClick={() => layout.moveBand(band, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
              </span>
            </div>
            <ul className="grid gap-1.5">
              {ordered.map((id, pos) => {
                const def = BLOCK_DEF[id];
                const isColumn = COLUMN_BLOCKS.has(id);
                return (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-3 rounded-sm border border-border-soft px-2.5 py-1.5"
                  >
                    <span className="text-[13px] text-fg">{def?.label ?? id}</span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-flex gap-1" role="group" aria-label="Ordem do bloco">
                        <Button
                          variant="icon"
                          size="sm"
                          type="button"
                          aria-label={`Mover ${def?.label ?? id} para a esquerda`}
                          disabled={isColumn || pos === 0}
                          onClick={() => layout.moveBlock(id, ordered, -1)}
                        >
                          <ArrowUp aria-hidden="true" />
                        </Button>
                        <Button
                          variant="icon"
                          size="sm"
                          type="button"
                          aria-label={`Mover ${def?.label ?? id} para a direita`}
                          disabled={isColumn || pos === ordered.length - 1}
                          onClick={() => layout.moveBlock(id, ordered, 1)}
                        >
                          <ArrowDown aria-hidden="true" />
                        </Button>
                      </span>
                      <CcToggle
                        ariaLabel={`Exibir bloco ${def?.label ?? id}`}
                        checked={layout.isVisible(id)}
                        onChange={(on) => layout.setVisible(id, on)}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
