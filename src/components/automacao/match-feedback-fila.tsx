"use client";

import { Inbox } from "lucide-react";
import type { MatchFeedbackAcao } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { useMatchFeedbackFila } from "@/hooks/use-match-feedback";
import { WidgetError } from "@/components/cockpit/widget-error";

const ACAO_LABEL: Record<MatchFeedbackAcao, string> = {
  corrigir: "Corrigir",
  remover: "Tirar",
  adicionar: "Adicionar",
};

/** Texto "sugerido → correto" de uma correcao, conforme a acao. */
function descreveCorrecao(item: {
  acao: MatchFeedbackAcao;
  produtoSugeridoNome: string | null;
  skuSugeridoCodigo: string | null;
  produtoCorretoNome: string | null;
  skuCorretoCodigo: string | null;
}): string {
  const sug = [item.produtoSugeridoNome, item.skuSugeridoCodigo].filter(Boolean).join(" / ") || "—";
  const cor = [item.produtoCorretoNome, item.skuCorretoCodigo].filter(Boolean).join(" / ") || "—";
  if (item.acao === "remover") return `${sug} → (sem match)`;
  if (item.acao === "adicionar") return `(sem match) → ${cor}`;
  return `${sug} → ${cor}`;
}

/**
 * cmp-match-feedback-fila — Fila read-only das correcoes de match pendentes de
 * curadoria (aba Aprendizado). A promocao para regra/metodo e feita no chat com
 * a Lia (padrao SOM); aqui so se visualiza o que foi capturado.
 */
export function MatchFeedbackFila() {
  const fila = useMatchFeedbackFila("pendente");
  const itens = fila.data?.itens ?? [];
  const loading = fila.isLoading;

  return (
    <>
      <div className="section-title">
        <h3>Correções de match</h3>
        {!loading && !fila.isError ? <span className="count">{itens.length}</span> : null}
      </div>
      <p className="helper" style={{ marginTop: 2, marginBottom: 16 }}>
        Correções de match feitas na triagem, pendentes de curadoria. Cada uma
        vira regra de cotação ou ajuste no método do agente (revisão com a Lia).
      </p>

      {fila.isError ? (
        <WidgetError
          title="Não foi possível carregar"
          message="Não foi possível carregar a fila de correções. Tente novamente."
          onRetry={() => fila.refetch()}
        />
      ) : (
        <div className="tbl-wrap tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Ação</th>
                <th>Correção</th>
                <th>Motivo</th>
                <th>Autor</th>
                <th>Quando</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6}>
                    <span className="skel skel-line" style={{ width: "60%" }} />
                  </td>
                </tr>
              ) : itens.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">
                      <Inbox aria-hidden="true" />
                      <h4>Nenhuma correção pendente.</h4>
                      <p>As correções surgem ao marcar um match como errado na triagem.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                itens.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <span title={it.itemDescricao ?? undefined}>
                        {it.itemDescricao ?? "—"}
                      </span>
                    </td>
                    <td>
                      <span className="tag">{ACAO_LABEL[it.acao]}</span>
                    </td>
                    <td className="sub">{descreveCorrecao(it)}</td>
                    <td className="sub">{it.motivo}</td>
                    <td className="sub">{it.autor ?? "—"}</td>
                    <td className="sub tnum">{formatDate(it.criadoEm)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
