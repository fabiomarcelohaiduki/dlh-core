"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, Info, PencilLine, Plus, TriangleAlert } from "lucide-react";
import type { AvisoDocumento, AvisoItem, AvisoItemMatch, ItensStatus } from "@/lib/api/types";
import { formatCurrency, formatNumber } from "@/lib/format";
import { useAvisoItens } from "@/hooks/use-aviso-itens";
import { MatchFeedbackPanel } from "@/components/automacao/match-feedback-panel";

/** Rotulo legivel do estado de extracao de itens de um documento. */
const STATUS_LABEL: Record<ItensStatus, string> = {
  pendente: "Aguardando a Lia",
  pendente_revisao: "Rascunho a revisar",
  extraido: "Itens extraídos",
  sem_itens: "Sem itens",
  erro: "Erro na extração",
  inobtenivel: "Texto indisponível",
  ignorado: "Ignorado",
};

/** Rotulo legivel da proveniencia do item. */
const ORIGEM_LABEL: Record<string, string> = {
  deterministico: "determinístico",
  llm: "LLM",
  effecti: "Effecti",
};

/** Grupo de itens de uma mesma lista (listas convivem; nunca fundidas). */
interface ListaGrupo {
  listaOrigem: string;
  fonteDescricao: string;
  itens: AvisoItem[];
}

/** Agrupa os itens de um documento por lista_origem, preservando a ordem. */
function agruparPorLista(itens: AvisoItem[]): ListaGrupo[] {
  const grupos: ListaGrupo[] = [];
  const idx = new Map<string, ListaGrupo>();
  for (const it of itens) {
    let g = idx.get(it.listaOrigem);
    if (!g) {
      g = { listaOrigem: it.listaOrigem, fonteDescricao: it.fonteDescricao, itens: [] };
      idx.set(it.listaOrigem, g);
      grupos.push(g);
    }
    g.itens.push(it);
  }
  return grupos;
}

function ListaTabela({
  grupo,
  matchById,
  avisoId,
  editingId,
  setEditingId,
  onSaved,
}: {
  grupo: ListaGrupo;
  matchById: Map<string, AvisoItemMatch>;
  avisoId: string;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onSaved: (msg: string) => void;
}) {
  const isPortal = grupo.fonteDescricao === "portal";
  // Prioridade tri-nivel: match no catalogo (0) > destacado pelo Effecti sem
  // match (1) > restante (2). Dentro de cada nivel preserva a ordem original da
  // lista (estavel via [].sort).
  const itensOrdenados = useMemo(() => {
    const rank = (it: AvisoItem) => (matchById.has(it.id) ? 0 : it.effecti ? 1 : 2);
    return grupo.itens
      .map((it, i) => ({ it, i, r: rank(it) }))
      .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r));
  }, [grupo.itens, matchById]);

  return (
    <div className="cell-stack">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="tag">{grupo.listaOrigem}</span>
        <span className="sub">
          {isPortal ? "descrição do portal (não confiável)" : "descrição técnica"}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Descrição</th>
            <th>Unid.</th>
            <th>Qtd.</th>
            <th>Preço ref. (unit.)</th>
          </tr>
        </thead>
        <tbody>
          {itensOrdenados.map(({ it, i }) => {
            const match = matchById.get(it.id);
            return (
              <Fragment key={it.id || `${it.itemNumero ?? ""}-${it.ordem ?? i}`}>
                <tr className={match ? "row-aprovado" : undefined}>
                  <td className="sub tnum">{it.itemNumero || (it.ordem != null ? `${it.ordem}` : "—")}</td>
                  <td>
                    {it.descricao}
                    {it.effecti ? (
                      <>
                        {" "}
                        <span className="tag effecti">Effecti</span>
                      </>
                    ) : null}
                    {it.itemEstado === "rascunho" ? (
                      <>
                        {" "}
                        <span className="tag duvida">rascunho</span>
                      </>
                    ) : null}
                    {it.itemEstado === "suspeito" ? (
                      <>
                        {" "}
                        <span className="tag lixo" title={it.suspeitoMotivo ?? undefined}>
                          suspeito
                        </span>
                      </>
                    ) : null}
                    {it.itemOrigem ? (
                      <>
                        {" "}
                        <span className="sub">· {ORIGEM_LABEL[it.itemOrigem] ?? it.itemOrigem}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="sub tnum">{it.unidade || "—"}</td>
                  <td className="sub tnum">{it.quantidade != null ? formatNumber(it.quantidade) : "—"}</td>
                  <td className="sub tnum">
                    {it.precoReferencia != null ? formatCurrency(it.precoReferencia) : "—"}
                  </td>
                </tr>
                {match && (
                  <tr className="row-match">
                    <td aria-hidden="true" />
                    <td colSpan={4}>
                      <span className="match-produto">
                        <span className="tag aprovado">match</span>
                        <strong>{match.produtoNome ?? "produto do catálogo"}</strong>
                        {match.skuCodigo ? (
                          <span className="tag">SKU {match.skuCodigo}</span>
                        ) : null}
                        {match.score != null ? (
                          <span className="sub">similaridade {match.score.toFixed(2)}</span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                )}
                {editingId === it.id ? (
                  <tr className="row-match">
                    <td aria-hidden="true" />
                    <td colSpan={4}>
                      <MatchFeedbackPanel
                        avisoId={avisoId}
                        item={it}
                        match={match ?? null}
                        onClose={() => setEditingId(null)}
                        onSaved={onSaved}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr className="row-match">
                    <td aria-hidden="true" />
                    <td colSpan={4}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setEditingId(it.id)}
                      >
                        {match ? (
                          <>
                            <PencilLine aria-hidden="true" />
                            Corrigir match
                          </>
                        ) : (
                          <>
                            <Plus aria-hidden="true" />
                            Adicionar match
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DocumentoBloco({
  doc,
  itens,
  matchById,
  avisoId,
  editingId,
  setEditingId,
  onSaved,
}: {
  doc: AvisoDocumento;
  itens: AvisoItem[];
  matchById: Map<string, AvisoItemMatch>;
  avisoId: string;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onSaved: (msg: string) => void;
}) {
  const grupos = useMemo(() => agruparPorLista(itens), [itens]);
  return (
    <div className="cell-stack">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong>{doc.nomeArquivo || doc.documentoId}</strong>
        <span className="tag">{STATUS_LABEL[doc.itensStatus] ?? doc.itensStatus}</span>
        {doc.ocrBaixaConfianca ? (
          <span
            className="tag lixo"
            title="OCR de baixa confiança: o texto pode estar corrompido; revise os números."
          >
            OCR baixa confiança
          </span>
        ) : null}
      </div>
      {grupos.length > 0
        ? grupos.map((g) => (
            <ListaTabela
              key={g.listaOrigem}
              grupo={g}
              matchById={matchById}
              avisoId={avisoId}
              editingId={editingId}
              setEditingId={setEditingId}
              onSaved={onSaved}
            />
          ))
        : (
          <span className="sub">
            {doc.itensStatus === "pendente"
              ? "Itens ainda não extraídos pela Lia."
              : "Nenhum item neste documento."}
          </span>
        )}
    </div>
  );
}

/**
 * cmp-aviso-itens-panel — Conteudo da linha expandida (recall por item).
 *
 * Busca LAZY (so renderiza quando a linha esta aberta) os documentos do aviso e
 * os itens extraidos. SO LEITURA: a extracao e da Lia. Itens agrupados por
 * documento e por lista de origem (listas convivem, nunca fundidas).
 */
export function AvisoItensPanel({ avisoId }: { avisoId: string }) {
  const { data, isLoading, isError, error } = useAvisoItens(avisoId, true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; message: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  function handleSaved(msg: string) {
    setToast({ kind: msg.startsWith("Erro") ? "err" : "ok", message: msg });
  }

  if (isLoading) {
    return <span className="skel skel-line" style={{ width: "40%" }} />;
  }
  if (isError) {
    return (
      <span className="sub">
        Falha ao carregar itens: {error instanceof Error ? error.message : "erro"}
      </span>
    );
  }
  const documentos = data?.documentos ?? [];
  const itens = data?.itens ?? [];
  const matches = data?.matches ?? [];
  const recallEffecti = data?.recallEffecti ?? [];
  if (documentos.length === 0) {
    return <span className="sub">Nenhum documento com texto para extrair itens.</span>;
  }

  const itensPorDoc = new Map<string, AvisoItem[]>();
  for (const it of itens) {
    const list = itensPorDoc.get(it.documentoId) ?? [];
    list.push(it);
    itensPorDoc.set(it.documentoId, list);
  }

  const matchById = new Map<string, AvisoItemMatch>(matches.map((m) => [m.documentoItemId, m]));

  return (
    <div className="cell-stack" style={{ gap: 16 }}>
      <div className="banner">
        <Info aria-hidden="true" />
        <div>
          <b>O veredito (Útil/Dúvida/Lixo) responde: vale participar do aviso?</b>
          <p>
            Basta 1 item cotável para o aviso ser Útil. Os itens com match errado você
            corrige aqui embaixo, item a item, sem mudar o veredito.
          </p>
        </div>
      </div>
      {recallEffecti.length > 0 ? (
        <div className="banner">
          <TriangleAlert aria-hidden="true" />
          <div>
            <b>
              Recall do Effecti: {recallEffecti.length}{" "}
              {recallEffecti.length === 1 ? "item do piso" : "itens do piso"} não apareceram na
              extração.
            </b>
            <p>
              O veredito foi rebaixado: a extração pode estar incompleta. Revise na fila de
              extração (Aprendizado).{" "}
              {recallEffecti
                .map((r) => r.itemDescricao || r.numeroSuspeito || "—")
                .join("; ")}
            </p>
          </div>
        </div>
      ) : null}
      {documentos.map((doc) => (
        <DocumentoBloco
          key={doc.documentoId}
          doc={doc}
          itens={itensPorDoc.get(doc.documentoId) ?? []}
          matchById={matchById}
          avisoId={avisoId}
          editingId={editingId}
          setEditingId={setEditingId}
          onSaved={handleSaved}
        />
      ))}
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
    </div>
  );
}
