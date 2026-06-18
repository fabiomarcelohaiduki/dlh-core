"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import type { FeedbackHumano, TriagemItem } from "@/lib/api/types";
import { useTriagem } from "@/hooks/use-triagem";
import { TriagemTable } from "@/components/automacao/triagem-table";
import {
  VereditoFiltro,
  type VereditoFiltroValue,
} from "@/components/automacao/veredito-filtro";
import { FeedbackButtons } from "@/components/automacao/feedback-buttons";
import { WidgetError } from "@/components/cockpit/widget-error";

type Toast = { kind: "ok" | "err"; message: string };

/**
 * AvisosClient — aba Triagem. Lista TODOS os avisos triados (inclui lixo),
 * filtro por veredito (client-side) e feedback inline acertou/errou. Paginacao
 * por cursor com footer "Carregar mais" (acumula as paginas por avisoId). O
 * feedback dispara use-triagem-feedback, exibe toast e invalida a lista.
 */
export function AvisosClient() {
  const [veredito, setVeredito] = useState<VereditoFiltroValue>("todos");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<TriagemItem[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);

  const triagem = useTriagem({ cursor });

  // Acumula as paginas carregadas, deduplicando por avisoId. O refetch leve da
  // pagina corrente apenas atualiza os itens ja presentes (sem duplicar).
  useEffect(() => {
    const page = triagem.data;
    if (!page) return;
    setItems((prev) => {
      const map = new Map(prev.map((i) => [i.avisoId, i]));
      for (const it of page.itens) map.set(it.avisoId, it);
      return Array.from(map.values());
    });
  }, [triagem.data]);

  // Auto-dismiss do toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // Filtro client-side por veredito sobre a lista carregada.
  const filtrados = useMemo(
    () =>
      veredito === "todos"
        ? items
        : items.filter((i) => i.veredito === veredito),
    [items, veredito],
  );

  const nextCursor = triagem.data?.nextCursor ?? null;
  const loading = triagem.isLoading && items.length === 0;

  // Atualizacao otimista do feedback gravado (a invalidacao refaz a pagina
  // corrente; aqui garantimos o reflexo imediato em qualquer pagina carregada).
  function handleFeedback(avisoId: string, feedback: FeedbackHumano) {
    setItems((prev) =>
      prev.map((i) => (i.avisoId === avisoId ? { ...i, feedbackHumano: feedback } : i)),
    );
    setToast({ kind: "ok", message: "Feedback registrado." });
  }

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h3>Triados</h3>
        {!loading && !triagem.isError && (
          <span className="count">{filtrados.length}</span>
        )}
      </div>

      <div className="filter-bar">
        <VereditoFiltro value={veredito} onChange={setVeredito} />
      </div>

      {triagem.isError ? (
        <WidgetError
          title="Não foi possível carregar"
          message="Não foi possível carregar. Tente novamente."
          onRetry={() => triagem.refetch()}
        />
      ) : (
        <TriagemTable
          variant="triagem"
          loading={loading}
          items={filtrados}
          emptyTitle={
            veredito === "todos"
              ? "Nenhum aviso triado ainda."
              : "Nenhum aviso para o filtro."
          }
          emptyDescription={
            veredito === "todos"
              ? "Quando a triagem classificar avisos, eles aparecem aqui."
              : "Nenhum aviso triado bate com o veredito selecionado."
          }
          renderAction={(item) => (
            <FeedbackButtons
              avisoId={item.avisoId}
              veredito={item.veredito}
              feedbackHumano={item.feedbackHumano}
              onSuccess={(fb) => handleFeedback(item.avisoId, fb)}
              onError={() =>
                setToast({
                  kind: "err",
                  message: "Não foi possível registrar o feedback. Tente novamente.",
                })
              }
            />
          )}
          footer={
            nextCursor ? (
              <div className="tbl-foot">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={triagem.isFetching}
                  onClick={() => setCursor(nextCursor)}
                >
                  Carregar mais
                </button>
              </div>
            ) : null
          }
        />
      )}

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
