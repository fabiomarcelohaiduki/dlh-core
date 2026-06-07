"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useErros } from "@/hooks/use-monitoring";
import { ErrosTable } from "@/components/cockpit/erros-table";
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
import type { Erro } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

/** Etapas filtraveis (action-filtrar-erro). "todos" = sem filtro de etapa. */
const ETAPA_FILTERS = [
  { value: "todos", label: "Todos" },
  { value: "Coleta", label: "Coleta" },
  { value: "Tratamento", label: "Tratamento" },
  { value: "Indexação", label: "Indexação" },
] as const;

type EtapaFilter = (typeof ETAPA_FILTERS)[number]["value"];

/** Recursos distintos presentes na lista (origem-aware) para o RecursoFiltro. */
function recursosDisponiveis(items: Erro[]): string[] {
  const set = new Set<string>();
  for (const it of items) {
    if (it.recurso) set.add(it.recurso);
  }
  return Array.from(set).sort();
}

export function ErrosClient() {
  const router = useRouter();
  const [etapa, setEtapa] = useState<EtapaFilter>("todos");
  const [origem, setOrigem] = useState<OrigemFiltroValue>("todas");
  const [recurso, setRecurso] = useState<RecursoFiltroValue>("todos");
  const [visiveis, setVisiveis] = useState(PAGE_SIZE);

  // useErros(etapa?) -> GET /ingestao/erros (com ?etapa= quando filtrado).
  const erros = useErros(etapa === "todos" ? undefined : etapa);
  const allItems = useMemo(() => erros.data?.items ?? [], [erros.data]);
  const recursos = useMemo(() => recursosDisponiveis(allItems), [allItems]);

  // Filtros client-side (origem/recurso) sobre a lista origem-aware.
  const filtrados = useMemo(
    () =>
      allItems.filter((e) => {
        if (origem !== "todas" && normalizeOrigem(e.origem) !== origem) return false;
        if (recurso !== "todos" && e.recurso !== recurso) return false;
        return true;
      }),
    [allItems, origem, recurso],
  );

  // Paginacao por offset (pageSize 25); lista ja ordenada por created_at desc.
  const items = useMemo(() => filtrados.slice(0, visiveis), [filtrados, visiveis]);
  const canLoadMore = filtrados.length > items.length;

  const filtrando = etapa !== "todos" || origem !== "todas" || recurso !== "todos";

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Erros de ingestão</h2>
          <p>
            Falhas de coleta, de tratamento dos arquivos e de indexação/embedding,
            de todas as origens. Abra um item para investigar o registro correspondente.
          </p>
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Filtros</h3>
        {!erros.isLoading && !erros.isError && (
          <span className="count">{filtrados.length}</span>
        )}
        <div className="right">
          <OrigemFiltro value={origem} onChange={setOrigem} />
          <RecursoFiltro recursos={recursos} value={recurso} onChange={setRecurso} />
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 14 }}>
        <h3>Etapa</h3>
        <div className="right" role="group" aria-label="Filtrar erros por etapa">
          {ETAPA_FILTERS.map((f) => {
            const active = etapa === f.value;
            return (
              <button
                key={f.value}
                type="button"
                className={cn("btn", "btn-sm", active && "btn-primary")}
                aria-pressed={active}
                onClick={() => setEtapa(f.value)}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {erros.isError ? (
        <WidgetError
          title="Erros indisponíveis"
          message="Não foi possível listar os erros de ingestão. Tente novamente."
          onRetry={() => erros.refetch()}
        />
      ) : (
        <ErrosTable
          variant="erros"
          loading={erros.isLoading}
          erros={items}
          emptyTitle={filtrando ? "Nenhum erro para o filtro" : "Nenhum erro registrado"}
          emptyDescription={
            filtrando
              ? "A ingestão está saudável para os filtros selecionados."
              : "Nenhum erro registrado: coleta, tratamento e indexação sem falhas."
          }
          onInvestigar={(avisoId) => router.push(`/edital/${avisoId}`)}
          footer={
            canLoadMore ? (
              <div className="tbl-foot">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setVisiveis((v) => v + PAGE_SIZE)}
                >
                  Carregar mais
                </button>
              </div>
            ) : null
          }
        />
      )}
    </section>
  );
}
