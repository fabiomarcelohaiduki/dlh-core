"use client";

// =====================================================================
// DryRunResultPanel - painel de resultado da simulacao (F3).
//
// Componente presentacional: recebe a `DryRunResponse` do ultimo dry-run
// e renderiza 4 secoes:
//   1) contagem_total (numero grande) + distribuicao_por_tipo (lista);
//   2) score_risco (Pill ok/aviso/bloqueio + lista de alertas SOFT);
//   3) bloco DURO vermelho quando `limite_tecnico_atingido` (nivel bloqueio);
//   4) amostra de arestas projetadas (tabela ate 50 entradas).
//
// O botao Ativar (data-btn='regra-ativar') vive no rodape do painel e e
// SEPARADO do Salvar. O pai controla o estado:
//   - `podeAtivar=false` desabilita o botao (frescor divergente OU nivel
//     bloqueio OU hard-block). `motivoBloqueio` explica no title.
//   - avisos SOFT (nivel='aviso') NAO desabilitam - o humano decide.
// A confirmacao dupla (dialog) e a mutation vivem no RegraForm (o pai).
// =====================================================================

import { AlertTriangle, Play, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pill, type PillProps } from "@/components/ui/pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  DryRunNivelRisco,
  DryRunResponse,
} from "@/lib/api/relacionamentos-types";

// Ate 50 arestas na amostra (criterio de aceite F3).
const AMOSTRA_MAX_LINHAS = 50;

// Mapa nivel do score -> variante da Pill + rotulo humano.
const NIVEL_META: Record<
  DryRunNivelRisco,
  { variant: PillProps["variant"]; label: string }
> = {
  ok: { variant: "ok", label: "Sem riscos detectados" },
  aviso: { variant: "warn", label: "Avisos - revise antes de ativar" },
  bloqueio: { variant: "danger", label: "Bloqueado" },
};

const NUMBER_FMT = new Intl.NumberFormat("pt-BR");

/** Formata confianca (0..1) como porcentagem inteira; passa-through se ja for >1. */
function formatConfianca(valor: number): string {
  const pct = valor <= 1 ? valor * 100 : valor;
  return `${Math.round(pct)}%`;
}

export interface DryRunResultPanelProps {
  /** Resposta do ultimo dry-run FRESCO. */
  data: DryRunResponse;
  /** Habilita o botao Ativar (frescor OK, sem bloqueio e sem hard-block). */
  podeAtivar: boolean;
  /** Motivo do bloqueio (title do botao) quando `podeAtivar=false`. */
  motivoBloqueio?: string | null;
  /** Estado de submissao da ativacao (spinner + label). */
  ativando?: boolean;
  /** Handler do clique em Ativar (abre a confirmacao dupla no pai). */
  onAtivarClick: () => void;
}

export function DryRunResultPanel({
  data,
  podeAtivar,
  motivoBloqueio,
  ativando = false,
  onAtivarClick,
}: DryRunResultPanelProps) {
  const nivel = data.score_risco.nivel;
  const nivelMeta = NIVEL_META[nivel];
  const alertas = data.score_risco.alertas ?? [];
  const limiteAtingido = Boolean(data.score_risco.limite_tecnico_atingido);
  const distribuicao = Object.entries(data.distribuicao_por_tipo ?? {});
  const amostra = data.amostra.slice(0, AMOSTRA_MAX_LINHAS);
  const amostraTruncada = data.amostra.length > AMOSTRA_MAX_LINHAS;

  return (
    <section
      data-card="dry-run-resultado"
      aria-label="Resultado da simulação da regra"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface-2/40 p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h4 className="text-[14px] font-semibold text-fg">
            Resultado da simulação
          </h4>
          <p className="text-[11.5px] text-faint">
            Projeção read-only sobre o substrato real. Nada foi persistido.
          </p>
        </div>
        <Pill variant={nivelMeta.variant} dot>
          {nivelMeta.label}
        </Pill>
      </header>

      {/* Secao 1: contagem_total + distribuicao_por_tipo --------------- */}
      <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
        <div
          data-metric="contagem-total"
          className="flex flex-col justify-center rounded-md border border-border bg-surface px-5 py-4"
        >
          <span className="text-[11px] font-bold uppercase tracking-wide text-soft">
            Arestas projetadas
          </span>
          <span className="mt-1 text-[34px] font-bold leading-none tracking-[-0.02em] text-fg tabular-nums">
            {NUMBER_FMT.format(data.contagem_total)}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wide text-soft">
            Distribuição por tipo
          </span>
          {distribuicao.length === 0 ? (
            <p className="text-[12.5px] text-faint">
              Sem quebra por tipo disponível.
            </p>
          ) : (
            <ul
              data-list="distribuicao-tipo"
              className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface"
            >
              {distribuicao.map(([tipo, qtd]) => (
                <li
                  key={tipo}
                  className="flex items-center justify-between px-3 py-1.5 text-[12.5px]"
                >
                  <span className="font-mono text-muted">{tipo}</span>
                  <span className="font-semibold text-fg tabular-nums">
                    {NUMBER_FMT.format(qtd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Secao 2: bloqueio DURO por limite tecnico --------------------- */}
      {limiteAtingido ? (
        <div
          role="alert"
          data-block="limite-tecnico"
          className="flex items-start gap-2.5 rounded-md border border-err bg-err-bg/60 px-3.5 py-3 text-err"
        >
          <ShieldAlert className="mt-0.5 size-5 flex-none" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-bold">
              Limite técnico atingido - ativação bloqueada
            </span>
            <span className="text-[12.5px] text-err/90">
              {data.score_risco.limite_tecnico_msg ??
                "O volume projetado excede o limite técnico suportado. Torne a regra mais específica (regra composta) e simule novamente."}
            </span>
          </div>
        </div>
      ) : null}

      {/* Secao 2b: alertas SOFT (nivel aviso) - NAO bloqueiam ---------- */}
      {alertas.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-soft">
            {nivel === "bloqueio" ? (
              <ShieldAlert className="size-3.5 text-err" aria-hidden="true" />
            ) : (
              <AlertTriangle className="size-3.5 text-warn" aria-hidden="true" />
            )}
            Alertas ({alertas.length})
          </span>
          <ul data-list="alertas" className="flex flex-col gap-1.5">
            {alertas.map((alerta) => (
              <li
                key={alerta.codigo}
                data-alerta={alerta.codigo}
                className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-bg/40 px-3 py-2 text-[12.5px] text-fg"
              >
                <AlertTriangle
                  className="mt-0.5 size-3.5 flex-none text-warn"
                  aria-hidden="true"
                />
                <span>
                  <span className="font-mono text-[11px] text-muted">
                    {alerta.codigo}
                  </span>
                  <span className="mx-1 text-faint">·</span>
                  {alerta.mensagem}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {nivel === "ok" && alertas.length === 0 && !limiteAtingido ? (
        <p className="flex items-center gap-1.5 text-[12.5px] text-ok">
          <ShieldCheck className="size-4" aria-hidden="true" />
          Nenhum alerta de risco - a regra está pronta para ativar.
        </p>
      ) : null}

      {/* Secao 3: amostra de arestas projetadas (ate 50) --------------- */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wide text-soft">
            Amostra de arestas
          </span>
          <span className="text-[11.5px] text-faint">
            {amostraTruncada
              ? `mostrando ${amostra.length} de ${NUMBER_FMT.format(data.contagem_total)}`
              : `${amostra.length} ${amostra.length === 1 ? "aresta" : "arestas"}`}
          </span>
        </div>
        {amostra.length === 0 ? (
          <p className="rounded-md border border-border bg-surface px-3 py-6 text-center text-[12.5px] text-faint">
            A simulação não produziu arestas de amostra.
          </p>
        ) : (
          <Table density="compact" sticky>
            <TableHeader>
              <TableRow>
                <TableHead>Origem</TableHead>
                <TableHead>Destino</TableHead>
                <TableHead>Relação</TableHead>
                <TableHead>Método</TableHead>
                <TableHead className="text-right">Confiança</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {amostra.map((aresta, idx) => (
                <TableRow key={`${aresta.origem_id}-${aresta.destino_id}-${idx}`}>
                  <TableCell>
                    <span className="flex flex-col">
                      <Pill variant="neutral" className="w-fit">
                        {aresta.origem_tipo}
                      </Pill>
                      <span className="mt-0.5 font-mono text-[11px] text-faint">
                        {aresta.origem_id}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-col">
                      <Pill variant="neutral" className="w-fit">
                        {aresta.destino_tipo}
                      </Pill>
                      <span className="mt-0.5 font-mono text-[11px] text-faint">
                        {aresta.destino_id}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-[11.5px] text-muted">
                    {aresta.relacao}
                  </TableCell>
                  <TableCell className="font-mono text-[11.5px] text-muted">
                    {aresta.metodo}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatConfianca(aresta.confianca)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Rodape: Ativar (efeito permanente, gate S7) ------------------- */}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <p className="max-w-[42ch] text-[11.5px] text-faint">
          Ativar dispara o backfill e tem <strong>efeito permanente</strong>.
          Exige confirmação dupla e um dry-run fresco.
        </p>
        <Button
          type="button"
          variant="primary"
          data-btn="regra-ativar"
          onClick={onAtivarClick}
          disabled={!podeAtivar || ativando}
          aria-disabled={!podeAtivar || ativando}
          title={!podeAtivar ? (motivoBloqueio ?? undefined) : undefined}
        >
          <Play aria-hidden="true" />
          <span>{ativando ? "Ativando…" : "Ativar regra"}</span>
        </Button>
      </footer>
    </section>
  );
}
