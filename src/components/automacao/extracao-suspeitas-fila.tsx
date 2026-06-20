"use client";

import { useState } from "react";
import { Inbox } from "lucide-react";
import type { ExtracaoSuspeitaFilaItem } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { useCurarExtracaoSuspeita, useExtracaoSuspeitasFila } from "@/hooks/use-extracao-suspeitas";
import { WidgetError } from "@/components/cockpit/widget-error";

const TIPO_LABEL: Record<ExtracaoSuspeitaFilaItem["tipo"], string> = {
  fidelidade: "Fidelidade",
  recall_effecti: "Recall Effecti",
};

/** Contexto legivel: objeto do aviso (recall) ou nome do documento (fidelidade). */
function contexto(it: ExtracaoSuspeitaFilaItem): string {
  if (it.tipo === "recall_effecti") return it.avisoObjeto ?? "—";
  return it.documentoNome ?? "—";
}

/**
 * cmp-extracao-suspeitas-fila — Fila de revisao de EXTRACAO (fidelidade /
 * recall do Effecti) escrita pelo servidor. O humano CURA cada linha:
 * confirmar (falso alarme), corrigir (informa o valor certo) ou descartar. Apos
 * curar, o item nao volta a ser re-marcado nas proximas re-extracoes (padrao SOM:
 * a fila nao age sozinha; a decisao e do humano).
 */
export function ExtracaoSuspeitasFila() {
  const fila = useExtracaoSuspeitasFila("pendente");
  const curar = useCurarExtracaoSuspeita();
  const itens = fila.data?.itens ?? [];
  const loading = fila.isLoading;

  // Linha em modo "corrigir" (id) + valores do formulario inline.
  const [corrigindoId, setCorrigindoId] = useState<string | null>(null);
  const [descricaoCorrigida, setDescricaoCorrigida] = useState("");
  const [numeroCorrigido, setNumeroCorrigido] = useState("");

  function abrirCorrigir(it: ExtracaoSuspeitaFilaItem) {
    setCorrigindoId(it.id);
    setDescricaoCorrigida(it.descricaoCorrigida ?? it.itemDescricao ?? "");
    setNumeroCorrigido(it.numeroCorrigido ?? it.numeroSuspeito ?? "");
  }

  function fecharCorrigir() {
    setCorrigindoId(null);
    setDescricaoCorrigida("");
    setNumeroCorrigido("");
  }

  function confirmar(id: string) {
    curar.mutate({ id, acao: "confirmar" });
  }

  function descartar(id: string) {
    curar.mutate({ id, acao: "descartar" });
  }

  function salvarCorrecao(id: string) {
    const descricao = descricaoCorrigida.trim();
    const numero = numeroCorrigido.trim();
    if (!descricao && !numero) return; // espelha a regra do Edge
    curar.mutate(
      {
        id,
        acao: "corrigir",
        descricaoCorrigida: descricao || null,
        numeroCorrigido: numero || null,
      },
      { onSuccess: fecharCorrigir },
    );
  }

  return (
    <>
      <div className="section-title">
        <h3>Revisão de extração</h3>
        {!loading && !fila.isError ? <span className="count">{itens.length}</span> : null}
      </div>
      <p className="helper" style={{ marginTop: 2, marginBottom: 16 }}>
        Itens marcados pelo servidor: número que não bate com o texto-fonte
        (fidelidade) ou item do piso Effecti ausente da extração (recall).
        Confirme (falso alarme), corrija o valor certo ou descarte.
      </p>

      {fila.isError ? (
        <WidgetError
          title="Não foi possível carregar"
          message="Não foi possível carregar a fila de revisão de extração. Tente novamente."
          onRetry={() => fila.refetch()}
        />
      ) : (
        <div className="tbl-wrap tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Item</th>
                <th>Número</th>
                <th>Motivo</th>
                <th>Contexto</th>
                <th>Quando</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7}>
                    <span className="skel skel-line" style={{ width: "60%" }} />
                  </td>
                </tr>
              ) : itens.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">
                      <Inbox aria-hidden="true" />
                      <h4>Nenhuma suspeita pendente.</h4>
                      <p>As suspeitas surgem quando o servidor reprova a fidelidade ou o recall.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                itens.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <span className="tag">{TIPO_LABEL[it.tipo]}</span>
                    </td>
                    <td>
                      <span title={it.itemDescricao ?? undefined}>{it.itemDescricao ?? "—"}</span>
                    </td>
                    <td className="sub tnum">{it.numeroSuspeito ?? "—"}</td>
                    <td className="sub">{it.motivo}</td>
                    <td className="sub">
                      <span title={contexto(it)}>{contexto(it)}</span>
                    </td>
                    <td className="sub tnum">{formatDate(it.criadoEm)}</td>
                    <td>
                      {corrigindoId === it.id ? (
                        <div className="cell-stack" style={{ gap: 6 }}>
                          <input
                            type="text"
                            value={descricaoCorrigida}
                            onChange={(e) => setDescricaoCorrigida(e.target.value)}
                            placeholder="Descrição correta"
                            aria-label="Descrição correta"
                          />
                          <input
                            type="text"
                            value={numeroCorrigido}
                            onChange={(e) => setNumeroCorrigido(e.target.value)}
                            placeholder="Número correto"
                            aria-label="Número correto"
                          />
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={curar.isPending ||
                                (!descricaoCorrigida.trim() && !numeroCorrigido.trim())}
                              onClick={() => salvarCorrecao(it.id)}
                            >
                              Salvar
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={fecharCorrigir}
                              disabled={curar.isPending}
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={curar.isPending}
                            onClick={() => confirmar(it.id)}
                          >
                            Confirmar
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={curar.isPending}
                            onClick={() => abrirCorrigir(it)}
                          >
                            Corrigir
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={curar.isPending}
                            onClick={() => descartar(it.id)}
                          >
                            Descartar
                          </button>
                        </div>
                      )}
                    </td>
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
