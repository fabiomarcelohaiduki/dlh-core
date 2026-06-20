"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import type { ExemploFewShot } from "@/lib/api/types";
import type { ListExemplosParams } from "@/lib/api/automacao";
import {
  useDeleteExemplo,
  useToggleExemplo,
  useTriagemExemplos,
} from "@/hooks/use-triagem-exemplos";
import { cn } from "@/lib/utils";
import { ExemplosTable } from "@/components/automacao/exemplos-table";
import { MatchFeedbackFila } from "@/components/automacao/match-feedback-fila";
import { ExtracaoSuspeitasFila } from "@/components/automacao/extracao-suspeitas-fila";
import {
  VereditoFiltro,
  type VereditoFiltroValue,
} from "@/components/automacao/veredito-filtro";
import { WidgetError } from "@/components/cockpit/widget-error";

type AtivoFiltro = "todos" | "ativos" | "inativos";
type Toast = { kind: "ok" | "err"; message: string };

const ATIVO_OPTS: { value: AtivoFiltro; label: string }[] = [
  { value: "todos", label: "Todos" },
  { value: "ativos", label: "Ativos" },
  { value: "inativos", label: "Inativos" },
];

/**
 * AprendizadoClient — aba Aprendizado. Curadoria do acervo few-shot
 * (triagem_exemplos): lista os exemplos (texto, veredito rotulado, status,
 * criado em), filtra por veredito e por ativo, e permite desativar/reativar
 * (PATCH, soft-delete reversivel) ou remover (DELETE) com loading por linha. As
 * mutacoes invalidam a lista (hooks) e a acumulacao por cursor reinicia a cada
 * mutacao/filtro para refletir o estado atual. Erro de carga usa WidgetError.
 */
export function AprendizadoClient() {
  const [veredito, setVeredito] = useState<VereditoFiltroValue>("todos");
  const [ativoFiltro, setAtivoFiltro] = useState<AtivoFiltro>("todos");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<ExemploFewShot[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);

  const toggleExemplo = useToggleExemplo();
  const deleteExemplo = useDeleteExemplo();

  const params = useMemo<ListExemplosParams>(() => {
    const p: ListExemplosParams = {};
    if (veredito !== "todos") p.veredito = veredito;
    if (ativoFiltro !== "todos") p.ativo = ativoFiltro === "ativos";
    if (cursor) p.cursor = cursor;
    return p;
  }, [veredito, ativoFiltro, cursor]);

  const exemplos = useTriagemExemplos(params);

  // Reinicia a acumulacao quando o filtro muda (nova query a partir da pagina 1).
  useEffect(() => {
    setItems([]);
    setCursor(undefined);
  }, [veredito, ativoFiltro]);

  // Acumula as paginas carregadas, deduplicando por id.
  useEffect(() => {
    const page = exemplos.data;
    if (!page) return;
    setItems((prev) => {
      const map = new Map(prev.map((i) => [i.id, i]));
      for (const it of page.itens) map.set(it.id, it);
      return Array.from(map.values());
    });
  }, [exemplos.data]);

  // Auto-dismiss do toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const nextCursor = exemplos.data?.nextCursor ?? null;
  const loading = exemplos.isLoading && items.length === 0;

  function handleToggle(exemplo: ExemploFewShot) {
    toggleExemplo.mutate(
      { id: exemplo.id, ativo: !exemplo.ativo },
      {
        onSuccess: () => {
          // Atualizacao otimista: reflete o novo estado e remove da visao quando
          // deixa de bater com o filtro de ativo selecionado.
          setItems((prev) =>
            prev
              .map((i) => (i.id === exemplo.id ? { ...i, ativo: !exemplo.ativo } : i))
              .filter(
                (i) =>
                  ativoFiltro === "todos" ||
                  (ativoFiltro === "ativos" ? i.ativo : !i.ativo),
              ),
          );
          setToast({
            kind: "ok",
            message: exemplo.ativo ? "Exemplo desativado." : "Exemplo reativado.",
          });
        },
        onError: () =>
          setToast({
            kind: "err",
            message: "Não foi possível atualizar o exemplo. Tente novamente.",
          }),
      },
    );
  }

  function handleDelete(exemplo: ExemploFewShot) {
    deleteExemplo.mutate(exemplo.id, {
      onSuccess: () => {
        setItems((prev) => prev.filter((i) => i.id !== exemplo.id));
        setToast({ kind: "ok", message: "Exemplo removido." });
      },
      onError: () =>
        setToast({
          kind: "err",
          message: "Não foi possível remover o exemplo. Tente novamente.",
        }),
    });
  }

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Aprendizado</h3>
        {!loading && !exemplos.isError && <span className="count">{items.length}</span>}
      </div>

      <p className="helper" style={{ marginTop: 2, marginBottom: 16 }}>
        Acervo de exemplos rotulados (few-shot) usado pelo subagente. Desative
        para tirar de circulação sem apagar, ou remova de vez.
      </p>

      <div className="filter-bar" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <VereditoFiltro value={veredito} onChange={setVeredito} />
        <div className="filter-group segmented" role="group" aria-label="Filtrar por status">
          {ATIVO_OPTS.map((opt) => {
            const active = ativoFiltro === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                className={cn("btn", "btn-sm", active && "btn-primary")}
                aria-pressed={active}
                onClick={() => setAtivoFiltro(opt.value)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {exemplos.isError ? (
        <WidgetError
          title="Não foi possível carregar"
          message="Não foi possível carregar o acervo. Tente novamente."
          onRetry={() => exemplos.refetch()}
        />
      ) : (
        <ExemplosTable
          loading={loading}
          items={items}
          emptyTitle="Nenhum exemplo de aprendizado ainda."
          emptyDescription={
            veredito === "todos" && ativoFiltro === "todos"
              ? "Os exemplos surgem do feedback humano na triagem."
              : "Nenhum exemplo bate com os filtros selecionados."
          }
          togglingId={toggleExemplo.isPending ? toggleExemplo.variables?.id ?? null : null}
          deletingId={deleteExemplo.isPending ? deleteExemplo.variables ?? null : null}
          onToggle={handleToggle}
          onDelete={handleDelete}
          footer={
            nextCursor ? (
              <div className="tbl-foot">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={exemplos.isFetching}
                  onClick={() => setCursor(nextCursor)}
                >
                  Carregar mais
                </button>
              </div>
            ) : null
          }
        />
      )}

      <div style={{ marginTop: 32 }}>
        <MatchFeedbackFila />
      </div>

      <div style={{ marginTop: 32 }}>
        <ExtracaoSuspeitasFila />
      </div>

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            right: 24,
            bottom: 24,
            zIndex: 50,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "11px 15px",
            borderRadius: "var(--r-sm)",
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: toast.kind === "err" ? "var(--err)" : "var(--ok)",
            fontSize: 13,
            fontWeight: 600,
            boxShadow: "var(--shadow-card)",
          }}
        >
          {toast.kind === "err" ? (
            <TriangleAlert aria-hidden="true" width={16} height={16} />
          ) : (
            <Check aria-hidden="true" width={16} height={16} />
          )}
          {toast.message}
        </div>
      ) : null}
    </>
  );
}
