"use client";

// =====================================================================
// cockpit-settings-form — Configuração do cockpit (delta-16/17/29).
//
// Dois grupos configuraveis, ambos com persistencia AO VIVO (sem botao Salvar):
//   - Cards de módulo (tipo `card`)   -> visibilidade + ordem + métrica exibida.
//   - Painéis fixos   (tipo `widget`) -> visibilidade + ordem + dado exibido.
//
// Cada item expoe setas de ordem, um select de dado (métrica do escopo / dado do
// painel) e um cc-toggle (visivel). Cards seguem os MESMOS escopos que a view do
// cockpit renderiza (COCKPIT_SCOPES): ligar/desligar e trocar a métrica reflete
// ao vivo em renderCockpitCards. Escopos/paineis sem catálogo caem no fallback
// honesto "Sem dado configurado" (select desabilitado). As escritas vao para
// `bloco_config` via upsert em lote (visivel/ordem/valor).
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, TriangleAlert } from "lucide-react";
import {
  COCKPIT_WIDGETS,
  widgetDataFor,
} from "@/lib/cockpit-config";
import {
  COCKPIT_SCOPES,
  metricsForScope,
} from "@/lib/cockpit/sources";
import { makeScopeConfig, scopeValueId } from "@/lib/engines/block-vis";
import { useBlocoConfig, useUpsertBlocoConfig } from "@/hooks/use-configuracao";
import type { BlocoConfigUpsertInput } from "@/lib/api/bloco-config";
import type { BlocoTipo } from "@/types/database";
import { CcRow } from "./cc-row";
import { CcToggle } from "./cc-toggle";
import { CcSelect } from "./cc-select";
import { CfgAccordion } from "./cfg-accordion";

/** Opção neutra de catálogo (id + rótulo) compartilhada por métricas e dados. */
interface DataOption {
  id: string;
  label: string;
}

/** Item generico de uma lista configuravel (card ou widget). */
interface ConfigItem {
  escopo: string;
  title: string;
  description: string;
  ordem: number;
  catalogIndex: number;
  /** visibilidade default quando ainda não há decisão salva. */
  defaultOn: boolean;
  /** indentado (submódulo) — apenas para cards. */
  sub: boolean;
  /** catálogo de dados selecionáveis (vazio = "Sem dado configurado"). */
  options: readonly DataOption[];
  /** id do dado atualmente selecionado. */
  valueId: string | undefined;
}

type Toast = { kind: "ok" | "err"; message: string };

export function CockpitSettingsForm() {
  const { data: cards, isLoading: loadingCards } = useBlocoConfig(undefined, "card");
  const { data: widgets, isLoading: loadingWidgets } = useBlocoConfig(undefined, "widget");
  const upsert = useUpsertBlocoConfig();
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const cardsCfg = useMemo(() => makeScopeConfig("card", cards ?? []), [cards]);
  const widgetsCfg = useMemo(() => makeScopeConfig("widget", widgets ?? []), [widgets]);

  // Cards: mesmos escopos que a view renderiza (módulos on, submódulos off).
  const cardItems = useMemo<ConfigItem[]>(
    () =>
      COCKPIT_SCOPES.map((s, i) => ({
        escopo: s.escopo,
        title: s.label,
        description: s.desc,
        ordem: cardsCfg.ordemOf(s.escopo, i),
        catalogIndex: i,
        defaultOn: s.parent === null,
        sub: s.parent !== null,
        options: metricsForScope(s.escopo),
        valueId: scopeValueId(cardsCfg.valorOf(s.escopo)),
      })).sort((a, b) => a.ordem - b.ordem || a.catalogIndex - b.catalogIndex),
    [cardsCfg],
  );

  const widgetItems = useMemo<ConfigItem[]>(
    () =>
      COCKPIT_WIDGETS.map((w, i) => ({
        escopo: w.escopo,
        title: w.label,
        description: w.desc,
        ordem: widgetsCfg.ordemOf(w.escopo, i),
        catalogIndex: i,
        defaultOn: true,
        sub: false,
        options: widgetDataFor(w.escopo),
        valueId: scopeValueId(widgetsCfg.valorOf(w.escopo)),
      })).sort((a, b) => a.ordem - b.ordem || a.catalogIndex - b.catalogIndex),
    [widgetsCfg],
  );

  function commit(items: BlocoConfigUpsertInput[]) {
    if (items.length === 0) return;
    upsert.mutate(items, {
      onSuccess: () => setToast({ kind: "ok", message: "Cockpit atualizado." }),
      onError: () =>
        setToast({
          kind: "err",
          message: "Não foi possível salvar. Tente novamente.",
        }),
    });
  }

  const isLoading = loadingCards || loadingWidgets;

  function renderGroup(
    items: ConfigItem[],
    tipo: BlocoTipo,
    cfgIsOn: (escopo: string, fallback: boolean) => boolean,
    dataMark: string,
  ) {
    return items.map((item, pos) => {
      const visivel = cfgIsOn(item.escopo, item.defaultOn);
      return (
        <CcRow
          key={item.escopo}
          title={item.title}
          description={item.description}
          sub={item.sub}
          controls={
            <ItemControls
              label={item.title}
              visivel={visivel}
              options={item.options}
              valueId={item.valueId}
              dataMark={dataMark}
              canUp={pos > 0}
              canDown={pos < items.length - 1}
              onToggle={(on) =>
                commit([{ escopo: item.escopo, tipo, visivel: on }])
              }
              onChangeValue={(id) =>
                commit([{ escopo: item.escopo, tipo, valor: { value: id } }])
              }
              onMove={(dir) => commit(reorder(items, item.escopo, dir, tipo))}
            />
          }
        />
      );
    });
  }

  return (
    <section className="config-geral-view">
      <CfgAccordion>
      <section className="cfg-panel-card" aria-labelledby="cockpit-cards">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="cockpit-cards">Cards do cockpit</h3>
            <p>
              Quais cards de módulo aparecem na visão geral, em que ordem e qual
              dado cada um exibe.
            </p>
          </div>
          <span className="pill">Escopo: cockpit</span>
        </div>
        <p className="cc-grouptitle">
          Cards de módulo <span>métricas no topo do cockpit</span>
        </p>
        <div className="cc-mod" data-cockpit-cards-config>
          {isLoading ? (
            <p className="bm-loading">Carregando cards…</p>
          ) : (
            renderGroup(cardItems, "card", (e, f) => cardsCfg.isOn(e, f), "métrica")
          )}
        </div>
      </section>

      <section className="cfg-panel-card" aria-labelledby="cockpit-widgets">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="cockpit-widgets">Painéis fixos</h3>
            <p>Painéis operacionais exibidos abaixo dos cards do cockpit.</p>
          </div>
        </div>
        <p className="cc-grouptitle">
          Painéis fixos <span>mapa de sinais, saúde e atalhos</span>
        </p>
        <div className="cc-mod" data-cockpit-widgets-config>
          {isLoading ? (
            <p className="bm-loading">Carregando painéis…</p>
          ) : (
            renderGroup(widgetItems, "widget", (e, f) => widgetsCfg.isOn(e, f), "dado")
          )}
        </div>
      </section>
      </CfgAccordion>

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
    </section>
  );
}

/** Cluster de controles de um item: setas de ordem + select de dado + toggle. */
function ItemControls({
  label,
  visivel,
  options,
  valueId,
  dataMark,
  canUp,
  canDown,
  onToggle,
  onChangeValue,
  onMove,
}: {
  label: string;
  visivel: boolean;
  options: readonly DataOption[];
  valueId: string | undefined;
  dataMark: string;
  canUp: boolean;
  canDown: boolean;
  onToggle: (on: boolean) => void;
  onChangeValue: (id: string) => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <span className="bm-controls">
      <span className="bm-order" role="group" aria-label="Ordem">
        <button
          type="button"
          className="bm-arrow"
          aria-label={`Mover ${label} para cima`}
          disabled={!canUp}
          onClick={() => onMove(-1)}
        >
          <ArrowUp aria-hidden="true" width={14} height={14} />
        </button>
        <button
          type="button"
          className="bm-arrow"
          aria-label={`Mover ${label} para baixo`}
          disabled={!canDown}
          onClick={() => onMove(1)}
        >
          <ArrowDown aria-hidden="true" width={14} height={14} />
        </button>
      </span>
      <DataSelect
        label={label}
        kind={dataMark}
        options={options}
        valueId={valueId}
        disabled={!visivel}
        onChange={onChangeValue}
      />
      <CcToggle
        ariaLabel={`Exibir ${label}`}
        checked={visivel}
        onChange={onToggle}
      />
    </span>
  );
}

/**
 * Select do dado exibido (métrica do card / dado do painel). Sem catálogo, cai
 * num select desabilitado "Sem dado configurado" — fallback honesto (delta-29).
 */
function DataSelect({
  label,
  kind,
  options,
  valueId,
  disabled,
  onChange,
}: {
  label: string;
  kind: string;
  options: readonly DataOption[];
  valueId: string | undefined;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  if (options.length === 0) {
    return (
      <select
        className="cc-select"
        disabled
        aria-label={`${kind} de ${label}`}
      >
        <option>Sem dado configurado</option>
      </select>
    );
  }
  const current = options.find((o) => o.id === valueId)?.id ?? options[0].id;
  return (
    <CcSelect
      ariaLabel={`${kind} exibida em ${label}`}
      value={current}
      options={options.map((o) => ({ value: o.id, label: o.label }))}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

/**
 * Reordena um item na lista e reatribui ordem sequencial (0..n-1) a todos,
 * gerando os upserts a persistir. Lista vazia se o movimento sair dos limites.
 */
function reorder(
  list: readonly ConfigItem[],
  escopo: string,
  dir: -1 | 1,
  tipo: BlocoTipo,
): BlocoConfigUpsertInput[] {
  const idx = list.findIndex((i) => i.escopo === escopo);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= list.length) return [];
  const reordered = [...list];
  const [moved] = reordered.splice(idx, 1);
  reordered.splice(target, 0, moved);
  return reordered.map((item, i) => ({ escopo: item.escopo, tipo, ordem: i }));
}
