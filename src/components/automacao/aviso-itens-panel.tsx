"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  PencilLine,
  Plus,
  TriangleAlert,
} from "lucide-react";
import type { AvisoDocumento, AvisoItem, AvisoItemMatch, ItensStatus } from "@/lib/api/types";
import { formatCurrency, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
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

// =====================================================================
// Visao "Por item" (multifonte por numero): reune as aparicoes de um mesmo
// item (edital/TR/modelo/portal/Effecti) sob a chave (lote, item_numero),
// exibe a descricao prevalente na linha e expande as demais fontes. Espelha
// a semantica de pesos do backend (_shared/triagem-fila.ts): TR > edital >
// modelo > portal > Effecti. Agrupamento client-side: o endpoint do cockpit
// ja entrega a lista plana completa (sem limite de payload).
// =====================================================================

const FONTE_PESOS = { tr: 50, edital: 40, modelo: 30, portal: 20, effecti: 10 } as const;

/** Peso da fonte de uma aparicao (decide quem prevalece na divergencia). */
function pesoFonteItem(it: AvisoItem): number {
  if (it.effecti) return FONTE_PESOS.effecti;
  if (it.fonteDescricao === "portal") return FONTE_PESOS.portal;
  const l = it.listaOrigem.toLowerCase();
  if (/termo de refer[eê]ncia|\btr\b/.test(l)) return FONTE_PESOS.tr;
  if (/modelo|proposta|formul[aá]rio/.test(l)) return FONTE_PESOS.modelo;
  return FONTE_PESOS.edital;
}

/** Rotulo curto da fonte de uma aparicao (derivado do peso). */
function rotuloFonte(it: AvisoItem): string {
  if (it.effecti) return "Effecti";
  if (it.fonteDescricao === "portal") return "Portal";
  const l = it.listaOrigem.toLowerCase();
  if (/termo de refer[eê]ncia|\btr\b/.test(l)) return "TR";
  if (/modelo|proposta|formul[aá]rio/.test(l)) return "Modelo";
  return "Edital";
}

/** Numero normalizado (numerico canonico; texto em minusculas; null se vazio). */
function normNumero(v: string | null): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? String(Number(s)) : s.toLowerCase();
}

/** Lote efetivo: coluna lote ou, se nula, o "lote N" embutido no lista_origem
 *  (evita fundir produtos distintos de lotes diferentes em registro de precos). */
function loteEfetivo(it: AvisoItem): string {
  const col = (it.lote ?? "").trim();
  if (col !== "") return /^\d+$/.test(col) ? String(Number(col)) : col.toLowerCase();
  const m = it.listaOrigem.toLowerCase().match(/\blote\s*:?\s*([0-9]+)/);
  return m ? String(Number(m[1])) : "";
}

// SINAL de "mesmo numero, descricoes divergentes" (NAO acao). A chave de
// agrupamento e LITERAL: o numero do item. Nunca fundimos nem separamos por
// similaridade. Mas o mesmo numero pode aparecer em LISTAS INDEPENDENTES (ETP x
// TR x modelo) para produtos DIFERENTES; nesse caso marcamos um SINAL via
// Jaccard de tokens (>=3 chars) para o operador conferir CADA descricao literal.
// Threshold medido no substrato: mesmo-item mediana 0.58, diferentes 0.00.
const SIM_MIN = 0.3;

/** Tokens significativos (>=3 chars) de uma descricao, para similaridade. */
function tokensDescricao(desc: string): Set<string> {
  const out = new Set<string>();
  for (const t of desc.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3) out.add(t);
  }
  return out;
}

/** Similaridade de Jaccard entre dois conjuntos de tokens. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Ordem de prevalencia: peso da fonte desc, depois revisado, depois descricao
 *  mais longa (mais informativa). aparicoes[0] = prevalente. */
function cmpAparicao(a: AvisoItem, b: AvisoItem): number {
  const dp = pesoFonteItem(b) - pesoFonteItem(a);
  if (dp !== 0) return dp;
  const ra = a.itemEstado === "revisado" ? 0 : 1;
  const rb = b.itemEstado === "revisado" ? 0 : 1;
  if (ra !== rb) return ra - rb;
  return b.descricao.length - a.descricao.length;
}

/** SINAL: alguma aparicao diverge demais da prevalente (Jaccard < SIM_MIN).
 *  aps ja ordenado por prevalencia (indice 0 = prevalente). */
function divergenciaDescricao(aps: AvisoItem[]): boolean {
  if (aps.length <= 1) return false;
  const rep = tokensDescricao(aps[0].descricao);
  for (let i = 1; i < aps.length; i++) {
    if (jaccard(rep, tokensDescricao(aps[i].descricao)) < SIM_MIN) return true;
  }
  return false;
}

/** Grupo de aparicoes do mesmo item (aparicoes[0] = prevalente). */
interface GrupoNumero {
  chave: string;
  itemNumero: string | null;
  aparicoes: AvisoItem[];
  divergenciaUnidade: boolean;
  divergenciaQuantidade: boolean;
  divergenciaDescricao: boolean;
}

/** Monta o grupo a partir das aparicoes ja ordenadas por prevalencia. */
function montarGrupo(aps: AvisoItem[]): GrupoNumero {
  const unidades = new Set(
    aps.map((a) => (a.unidade ?? "").trim().toLowerCase()).filter(Boolean),
  );
  const quantidades = new Set(
    aps.filter((a) => a.quantidade != null).map((a) => a.quantidade),
  );
  return {
    chave: aps[0].id,
    itemNumero: aps[0].itemNumero,
    aparicoes: aps,
    divergenciaUnidade: unidades.size > 1,
    divergenciaQuantidade: quantidades.size > 1,
    divergenciaDescricao: divergenciaDescricao(aps),
  };
}

/** Agrupa os itens (de todos os documentos) por chave LITERAL (lote, item_numero),
 *  reunindo TODAS as aparicoes do mesmo numero. Chave deterministica: nunca funde
 *  nem separa por similaridade. Itens sem numero viram grupo unitario (recall-safe). */
function agruparPorNumero(itens: AvisoItem[]): GrupoNumero[] {
  const porChave = new Map<string, AvisoItem[]>();
  const ordem: string[] = [];
  for (const it of itens) {
    const num = normNumero(it.itemNumero);
    const chave = num === null ? `__solo__${it.id}` : `${loteEfetivo(it)}|${num}`;
    let arr = porChave.get(chave);
    if (!arr) {
      arr = [];
      porChave.set(chave, arr);
      ordem.push(chave);
    }
    arr.push(it);
  }
  const grupos: GrupoNumero[] = [];
  for (const chave of ordem) {
    const aps = (porChave.get(chave) as AvisoItem[]).slice().sort(cmpAparicao);
    grupos.push(montarGrupo(aps));
  }
  return grupos;
}

function GrupoNumeroLinha({
  grupo,
  docNome,
  matchById,
  avisoId,
  editingId,
  setEditingId,
  onSaved,
}: {
  grupo: GrupoNumero;
  docNome: Map<string, string | null>;
  matchById: Map<string, AvisoItemMatch>;
  avisoId: string;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onSaved: (msg: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const prevalece = grupo.aparicoes[0];
  const outras = grupo.aparicoes.slice(1);
  const temOutras = outras.length > 0;
  // Match: primeira aparicao (na ordem de peso) com match no catalogo.
  const aparicaoComMatch = grupo.aparicoes.find((a) => matchById.has(a.id)) ?? null;
  const match = aparicaoComMatch ? matchById.get(aparicaoComMatch.id) ?? null : null;
  const alvoMatch = aparicaoComMatch ?? prevalece;
  const editando = editingId === alvoMatch.id;

  return (
    <Fragment>
      <tr className={match ? "row-aprovado" : undefined}>
        <td className="sub tnum">
          {temOutras ? (
            <button
              type="button"
              className="btn btn-icon btn-sm"
              aria-expanded={aberto}
              aria-label={aberto ? "Recolher fontes" : "Ver outras fontes"}
              onClick={() => setAberto((v) => !v)}
              style={{ marginRight: 4 }}
            >
              {aberto ? (
                <ChevronDown aria-hidden="true" width={14} height={14} />
              ) : (
                <ChevronRight aria-hidden="true" width={14} height={14} />
              )}
            </button>
          ) : null}
          {grupo.itemNumero || "—"}
        </td>
        <td>
          {prevalece.descricao}{" "}
          <span className="tag">{rotuloFonte(prevalece)}</span>
          {temOutras ? (
            <>
              {" "}
              <span className="sub">
                · {grupo.aparicoes.length} fontes
              </span>
            </>
          ) : null}
          {grupo.divergenciaUnidade ? (
            <>
              {" "}
              <span className="tag duvida" title="Unidade diverge entre as fontes">
                unid. diverge
              </span>
            </>
          ) : null}
          {grupo.divergenciaQuantidade ? (
            <>
              {" "}
              <span className="tag duvida" title="Quantidade diverge entre as fontes">
                qtd. diverge
              </span>
            </>
          ) : null}
          {grupo.divergenciaDescricao ? (
            <>
              {" "}
              <span
                className="tag duvida"
                title="Descricoes divergem entre as fontes deste numero: possiveis produtos diferentes. Confira cada descricao."
              >
                descr. diverge
              </span>
            </>
          ) : null}
        </td>
        <td className="sub tnum">{prevalece.unidade || "—"}</td>
        <td className="sub tnum">
          {prevalece.quantidade != null ? formatNumber(prevalece.quantidade) : "—"}
        </td>
        <td className="sub tnum">
          {prevalece.precoReferencia != null ? formatCurrency(prevalece.precoReferencia) : "—"}
        </td>
      </tr>
      {aberto && temOutras
        ? outras.map((ap) => (
            <tr key={ap.id} className="row-match">
              <td aria-hidden="true" />
              <td colSpan={4}>
                <span className="cell-stack" style={{ gap: 2 }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="tag">{rotuloFonte(ap)}</span>
                    <span className="sub">
                      {docNome.get(ap.documentoId) || (ap.effecti ? "Effecti (itensEdital)" : ap.listaOrigem)}
                    </span>
                  </span>
                  <span>{ap.descricao}</span>
                  <span className="sub tnum">
                    {ap.unidade || "—"} · {ap.quantidade != null ? formatNumber(ap.quantidade) : "—"}
                    {ap.precoReferencia != null ? ` · ${formatCurrency(ap.precoReferencia)}` : ""}
                  </span>
                </span>
              </td>
            </tr>
          ))
        : null}
      {match ? (
        <tr className="row-match">
          <td aria-hidden="true" />
          <td colSpan={4}>
            <span className="match-produto">
              <span className="tag aprovado">match</span>
              <strong>{match.produtoNome ?? "produto do catálogo"}</strong>
              {match.skuCodigo ? <span className="tag">SKU {match.skuCodigo}</span> : null}
              {match.score != null ? (
                <span className="sub">similaridade {match.score.toFixed(2)}</span>
              ) : null}
            </span>
          </td>
        </tr>
      ) : null}
      {editando ? (
        <tr className="row-match">
          <td aria-hidden="true" />
          <td colSpan={4}>
            <MatchFeedbackPanel
              avisoId={avisoId}
              item={alvoMatch}
              match={match}
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
              onClick={() => setEditingId(alvoMatch.id)}
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
}

function ItensPorNumero({
  itens,
  documentos,
  matchById,
  avisoId,
  editingId,
  setEditingId,
  onSaved,
}: {
  itens: AvisoItem[];
  documentos: AvisoDocumento[];
  matchById: Map<string, AvisoItemMatch>;
  avisoId: string;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onSaved: (msg: string) => void;
}) {
  const docNome = useMemo(
    () => new Map(documentos.map((d) => [d.documentoId, d.nomeArquivo])),
    [documentos],
  );
  // Prioridade: grupos com match (0) > destacados pelo Effecti (1) > restante
  // (2). Dentro de cada nivel preserva a ordem do agrupamento (estavel).
  const grupos = useMemo(() => {
    const gs = agruparPorNumero(itens);
    const rank = (g: GrupoNumero) =>
      g.aparicoes.some((a) => matchById.has(a.id))
        ? 0
        : g.aparicoes.some((a) => a.effecti)
          ? 1
          : 2;
    return gs
      .map((g, i) => ({ g, i, r: rank(g) }))
      .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r))
      .map((x) => x.g);
  }, [itens, matchById]);

  if (grupos.length === 0) {
    return <span className="sub">Nenhum item extraído ainda.</span>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>Descrição (fonte prevalente)</th>
          <th>Unid.</th>
          <th>Qtd.</th>
          <th>Preço ref. (unit.)</th>
        </tr>
      </thead>
      <tbody>
        {grupos.map((g) => (
          <GrupoNumeroLinha
            key={g.chave}
            grupo={g}
            docNome={docNome}
            matchById={matchById}
            avisoId={avisoId}
            editingId={editingId}
            setEditingId={setEditingId}
            onSaved={onSaved}
          />
        ))}
      </tbody>
    </table>
  );
}

/**
 * cmp-aviso-itens-panel — Conteudo da linha expandida (recall por item).
 *
 * Busca LAZY (so renderiza quando a linha esta aberta) os documentos do aviso e
 * os itens extraidos. SO LEITURA: a extracao e da Lia. Duas vistas: "Por item"
 * (multifonte por numero, decisao) e "Por documento" (fidelidade da extracao,
 * listas convivem, nunca fundidas).
 */
export function AvisoItensPanel({ avisoId }: { avisoId: string }) {
  const { data, isLoading, isError, error } = useAvisoItens(avisoId, true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [vista, setVista] = useState<"item" | "documento">("item");
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
      <div className="filter-group segmented" role="group" aria-label="Visão dos itens">
        <button
          type="button"
          className={cn("btn", "btn-sm", vista === "item" && "btn-primary")}
          aria-pressed={vista === "item"}
          onClick={() => setVista("item")}
        >
          Por item
        </button>
        <button
          type="button"
          className={cn("btn", "btn-sm", vista === "documento" && "btn-primary")}
          aria-pressed={vista === "documento"}
          onClick={() => setVista("documento")}
        >
          Por documento
        </button>
      </div>
      {vista === "item" ? (
        <ItensPorNumero
          itens={itens}
          documentos={documentos}
          matchById={matchById}
          avisoId={avisoId}
          editingId={editingId}
          setEditingId={setEditingId}
          onSaved={handleSaved}
        />
      ) : (
        documentos.map((doc) => (
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
        ))
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
    </div>
  );
}
