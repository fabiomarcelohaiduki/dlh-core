"use client";

// =====================================================================
// mapa-sinais — painel fixo do cockpit (delta-17).
//
// Linha do tempo consolidada das execucoes (read-only, COCKPIT_SOURCES.runs)
// com filtro todos/pendencias/erros. Sem execucoes -> empty honesto. O estado
// da pill do cabeçalho agrega o pior estado observado (erro > em execução > ok).
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import {
  execucaoDescriptor,
  normalizeOrigem,
  origemLabel,
  type PillState,
} from "@/lib/status";
import { EmptyState } from "@/components/cockpit/ui/empty-state";
import { useCockpitMetrics } from "@/hooks/use-cockpit-metrics";
import { useBlocoConfig } from "@/hooks/use-configuracao";
import { makeScopeConfig, scopeValueId } from "@/lib/engines/block-vis";
import type { Execucao } from "@/lib/api/types";

type Filtro = "todos" | "pendencias" | "erros";

/** Valida o dado persistido (bloco_config.valor) como filtro conhecido. */
function asFiltro(id: string | undefined): Filtro {
  return id === "pendencias" || id === "erros" ? id : "todos";
}

const FILTROS: readonly { id: Filtro; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "pendencias", label: "Pendências" },
  { id: "erros", label: "Erros" },
];

/** estado da pill -> classe do LED do sinal. */
function ledClass(state: PillState): string {
  if (state === "err") return "signal-led err";
  if (state === "run" || state === "warn") return "signal-led warn";
  return "signal-led";
}

function headPill(runs: Execucao[]): { state: PillState; label: string } {
  if (runs.some((r) => r.status === "erro")) return { state: "err", label: "Atenção" };
  if (runs.some((r) => r.status === "em_andamento"))
    return { state: "run", label: "Em execução" };
  if (runs.length > 0) return { state: "ok", label: "Pronto" };
  return { state: "idle", label: "Sem sinais" };
}

function descricao(run: Execucao): string {
  const partes: string[] = [];
  if (run.recurso) partes.push(run.recurso);
  partes.push(`${run.novos} novos · ${run.alterados} alterados`);
  return partes.join(" · ");
}

export function MapaSinais() {
  const { runs } = useCockpitMetrics();

  // Dado configurado em "Configuração do cockpit" (bloco_config tipo widget):
  // reflete ao vivo o filtro escolhido no select da configuração do painel.
  const { data: widgetCfg } = useBlocoConfig(undefined, "widget");
  const dadoConfigurado = useMemo(
    () =>
      asFiltro(
        scopeValueId(
          makeScopeConfig("widget", widgetCfg ?? []).valorOf("mapa-sinais"),
        ),
      ),
    [widgetCfg],
  );

  const [filtro, setFiltro] = useState<Filtro>(dadoConfigurado);

  // Quando o dado configurado muda (config ao vivo), sincroniza o filtro ativo.
  useEffect(() => {
    setFiltro(dadoConfigurado);
  }, [dadoConfigurado]);

  const sinais = useMemo(() => {
    const ordenado = [...runs].sort((a, b) => b.inicio.localeCompare(a.inicio));
    const filtrado = ordenado.filter((r) => {
      if (filtro === "erros") return r.status === "erro";
      if (filtro === "pendencias") return r.status === "em_andamento";
      return true;
    });
    return filtrado.slice(0, 6);
  }, [runs, filtro]);

  const pill = headPill(runs);

  return (
    <section
      className="card cockpit-widget"
      data-cockpit-widget="mapa-sinais"
      aria-label="Mapa de sinais"
    >
      <div className="cockpit-widget-head">
        <div className="cockpit-widget-titles">
          <h3>Mapa de sinais</h3>
          <p>Leitura consolidada do cockpit operacional.</p>
        </div>
        <span className={`pill ${pill.state}`}>
          <span className="dot" />
          {pill.label}
        </span>
      </div>

      <div className="signal-filter" role="group" aria-label="Filtrar sinais">
        {FILTROS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={filtro === f.id ? "is-active" : ""}
            aria-pressed={filtro === f.id}
            onClick={() => setFiltro(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {sinais.length === 0 ? (
        <EmptyState hint="Nenhum sinal para o filtro selecionado." />
      ) : (
        <div className="signal-list">
          {sinais.map((run) => {
            const d = execucaoDescriptor(run);
            return (
              <div className="signal-card" data-status={d.state} key={run.id}>
                <span className={ledClass(d.state)} aria-hidden="true" />
                <span className="signal-copy">
                  <strong>{origemLabel(normalizeOrigem(run.origem))}</strong>
                  <span>{descricao(run)}</span>
                </span>
                <span className={`pill ${d.state}`}>{d.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
