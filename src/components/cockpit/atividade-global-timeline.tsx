"use client";

// =====================================================================
// AtividadeGlobalTimeline — timeline dos sinais recentes do ambiente.
//
// Casca (Fase 0): a estrutura de leitura está completa (filtro, estado vazio
// honesto, estado de erro de leitura e a região da timeline), pronta para
// receber a fonte real em pipelines futuros. Enquanto não há telemetria
// plugada, a timeline mostra os sinais semente do Design Lock (artifact
// atividade-global), já governados pelo filtro.
//
//  - Filtro Todos / Pendências / Erros (segmentado, molde travado dos filtros).
//  - Estado vazio honesto quando o filtro ativo não tem registros (delta-17).
//  - EC-21: erro de leitura → WidgetError ("Tentar novamente") DENTRO da região
//    da timeline, mantendo o filtro operável acima.
// =====================================================================

import { useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/cockpit/status-pill";
import { WidgetError } from "@/components/cockpit/widget-error";
import { EmptyState } from "@/components/cockpit/ui/empty-state";
import type { PillState } from "@/lib/status";

/** Natureza do sinal — base do filtro e da contagem "em atenção". */
type SinalKind = "ok" | "pendencia" | "erro";

/** Valor do filtro da timeline. */
type Filtro = "todos" | "pendencias" | "erros";

interface Sinal {
  id: string;
  title: string;
  detail: string;
  kind: SinalKind;
  pill: { state: PillState; label: string };
}

/** Sinais semente do Design Lock (artifact `panel-atividade-global`). */
const SINAIS: Sinal[] = [
  {
    id: "triagem",
    title: "Triagem aguardando validação",
    detail: "1 documento ficou fora da regra determinística.",
    kind: "pendencia",
    pill: { state: "warn", label: "Revisar" },
  },
  {
    id: "effecti",
    title: "Ingestão Effecti concluída",
    detail: "Lote sincronizado e disponível no acervo.",
    kind: "ok",
    pill: { state: "ok", label: "Normal" },
  },
  {
    id: "indexados",
    title: "Registros indexados",
    detail: "Metadados atualizados para consulta operacional.",
    kind: "ok",
    pill: { state: "ok", label: "Normal" },
  },
];

const FILTROS: { value: Filtro; label: string }[] = [
  { value: "todos", label: "Todos" },
  { value: "pendencias", label: "Pendências" },
  { value: "erros", label: "Erros" },
];

function matchFiltro(sinal: Sinal, filtro: Filtro): boolean {
  if (filtro === "todos") return true;
  if (filtro === "pendencias") return sinal.kind === "pendencia";
  return sinal.kind === "erro";
}

export function AtividadeGlobalTimeline() {
  const [filtro, setFiltro] = useState<Filtro>("todos");
  // EC-21: caminho real de erro de leitura. Na casca a fonte ainda não está
  // plugada (sem fetch), então parte resolvido; quando o pipeline ligar uma
  // leitura que falhe, basta sinalizar este estado para exibir o WidgetError.
  const [loadError, setLoadError] = useState(false);

  const visiveis = useMemo(
    () => SINAIS.filter((s) => matchFiltro(s, filtro)),
    [filtro],
  );

  const emAtencao = useMemo(
    () => SINAIS.filter((s) => s.kind !== "ok").length,
    [],
  );

  return (
    <div className="global-view global-view-grid">
      <section className="cfg-panel-card" aria-labelledby="atividade-global-h">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="atividade-global-h">Atividade global</h3>
            <p>Sinais recentes emitidos pelas automações do ambiente.</p>
          </div>
          {emAtencao > 0 ? (
            <StatusPill state="warn" label={`${emAtencao} em atenção`} />
          ) : (
            <StatusPill state="ok" label="Tudo normal" />
          )}
        </div>

        <div
          className="filter-group segmented"
          role="group"
          aria-label="Filtrar atividade"
        >
          {FILTROS.map((opt) => {
            const active = filtro === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                className={cn("btn", "btn-sm", active && "btn-primary")}
                aria-pressed={active}
                onClick={() => setFiltro(opt.value)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className="timeline-region">
          {loadError ? (
            <WidgetError
              title="Não foi possível carregar a atividade"
              message="Ocorreu uma falha ao ler os sinais do ambiente."
              onRetry={() => setLoadError(false)}
            />
          ) : visiveis.length === 0 ? (
            <EmptyState
              icon={<Activity aria-hidden="true" />}
              message="Sem sinais para este filtro"
              hint="Nenhum registro corresponde ao filtro selecionado."
            />
          ) : (
            <ul className="stack-list">
              {visiveis.map((s) => (
                <li className="stack-item" key={s.id}>
                  <div className="stack-copy">
                    <strong>{s.title}</strong>
                    <span>{s.detail}</span>
                  </div>
                  <StatusPill state={s.pill.state} label={s.pill.label} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <aside className="system-card" aria-label="Próxima janela">
        <span>Próxima janela</span>
        <strong>14:20</strong>
        <small>Nova rodada de leitura e reconciliação.</small>
      </aside>
    </div>
  );
}
