"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useExecucoes } from "@/hooks/use-monitoring";
import { useExecucoesRealtime } from "@/hooks/use-execucoes-realtime";
import { useColetar } from "@/hooks/use-fontes";
import { RunsTable } from "@/components/cockpit/runs-table";
import { ColetaButton } from "@/components/cockpit/coleta-button";
import { WidgetError } from "@/components/cockpit/widget-error";
import {
  OrigemFiltro,
  type OrigemFiltroValue,
} from "@/components/cockpit/origem-filtro";
import {
  RecursoFiltro,
  type RecursoFiltroValue,
} from "@/components/cockpit/recurso-filtro";
import { normalizeOrigem } from "@/lib/status";
import type { Execucao, FonteTipo } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;
/** Intervalo de fallback (refetch) quando o Realtime esta indisponivel. */
const FALLBACK_POLL_MS = 5000;
/** Poll rapido enquanto ha coleta em andamento (independe do Realtime). */
const RUNNING_POLL_MS = 3000;

/** Recursos distintos presentes na lista (origem-aware) para o RecursoFiltro. */
function recursosDisponiveis(items: Execucao[]): string[] {
  const set = new Set<string>();
  for (const it of items) {
    if (it.recurso) set.add(it.recurso);
  }
  return Array.from(set).sort();
}

export function ExecucoesClient() {
  const router = useRouter();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [origem, setOrigem] = useState<OrigemFiltroValue>("todas");
  const [recurso, setRecurso] = useState<RecursoFiltroValue>("todos");
  const [retomandoId, setRetomandoId] = useState<string | null>(null);

  // Realtime primeiro: define se o fallback de refetch fica ativo.
  const { connected } = useExecucoesRealtime();

  const execucoes = useExecucoes({
    limit,
    // Rede de seguranca: enquanto houver coleta em andamento, faz poll rapido
    // INDEPENDENTE do Realtime (a subscription pode chegar stale ou perder
    // eventos). Parado, so faz poll lento quando o Realtime nao esta conectado.
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      if (items.some((r) => r.status === "em_andamento")) return RUNNING_POLL_MS;
      return connected ? false : FALLBACK_POLL_MS;
    },
  });

  const coletar = useColetar();

  const allRuns = useMemo(() => execucoes.data?.items ?? [], [execucoes.data]);
  const recursos = useMemo(() => recursosDisponiveis(allRuns), [allRuns]);

  // Filtros client-side sobre a lista origem-aware ja carregada.
  const runs = useMemo(
    () =>
      allRuns.filter((r) => {
        if (origem !== "todas" && normalizeOrigem(r.origem) !== origem) return false;
        if (recurso !== "todos" && r.recurso !== recurso) return false;
        return true;
      }),
    [allRuns, origem, recurso],
  );

  const running = allRuns.some((r) => r.status === "em_andamento");
  const canLoadMore = !execucoes.isLoading && allRuns.length >= limit;

  async function handleRetomar(execucao: Execucao) {
    if (retomandoId) return;
    setRetomandoId(execucao.id);
    try {
      await coletar.mutateAsync({
        fonte: normalizeOrigem(execucao.origem) as FonteTipo,
        recurso: (execucao.recurso ?? "processos") as "processos",
      });
    } catch {
      // Feedback de falha fica a cargo do refetch/Realtime; nada a propagar.
    } finally {
      setRetomandoId(null);
    }
  }

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Execuções de sincronização</h2>
          <p>
            Histórico das coletas agendadas e sob demanda. A sincronização é incremental:
            traz apenas registros novos ou alterados desde a última execução.
          </p>
        </div>
        <div className="actions">
          <ColetaButton blocked={running} label="Coleta sob demanda" />
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Histórico de execuções</h3>
        {!execucoes.isLoading && !execucoes.isError && (
          <span className="count">{runs.length}</span>
        )}
        <div className="right">
          <OrigemFiltro value={origem} onChange={setOrigem} />
          <RecursoFiltro recursos={recursos} value={recurso} onChange={setRecurso} />
          <div
            className={cn("conn", connected ? "ok" : "reconnecting")}
            role="status"
            aria-live="polite"
          >
            {connected ? (
              <>
                <span className="dot" aria-hidden="true" />
                Tempo real ativo
              </>
            ) : (
              <>
                <Loader2 className="spin" aria-hidden="true" />
                Reconectando…
              </>
            )}
          </div>
        </div>
      </div>

      {execucoes.isError ? (
        <WidgetError
          title="Execuções indisponíveis"
          message="Não foi possível listar as execuções. Verifique a conexão e tente novamente."
          onRetry={() => execucoes.refetch()}
        />
      ) : (
        <RunsTable
          variant="execucoes"
          loading={execucoes.isLoading}
          runs={runs}
          emptyTitle={
            origem !== "todas" || recurso !== "todos"
              ? "Nenhuma execução para o filtro"
              : "Nenhuma execução ainda"
          }
          emptyDescription={
            origem !== "todas" || recurso !== "todos"
              ? "Ajuste os filtros de origem e recurso para ver outras execuções."
              : "Ainda não há coletas registradas. Dispare uma coleta sob demanda para começar."
          }
          emptyAction={<ColetaButton blocked={running} label="Coleta sob demanda" />}
          onErroClick={() => router.push("/erros")}
          onRetomar={handleRetomar}
          retomandoId={retomandoId}
          footer={
            canLoadMore ? (
              <div className="tbl-foot">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setLimit((l) => l + PAGE_SIZE)}
                  disabled={execucoes.isFetching}
                >
                  {execucoes.isFetching ? (
                    <>
                      <Loader2 className="spin" aria-hidden="true" />
                      Carregando…
                    </>
                  ) : (
                    "Carregar mais"
                  )}
                </button>
              </div>
            ) : null
          }
        />
      )}
    </section>
  );
}
