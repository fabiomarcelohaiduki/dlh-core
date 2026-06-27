"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { AvisoDocumento, AvisoItem, AvisoItemPortal, ItensStatus } from "@/lib/api/types";
import { formatCurrency, formatNumber } from "@/lib/format";
import { useAvisoItens, useColetarItensPortal } from "@/hooks/use-aviso-itens";
import { cn } from "@/lib/utils";

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

/** Tabela de uma lista: itens literais extraidos, na ordem original (sem match). */
function ListaTabela({ grupo }: { grupo: ListaGrupo }) {
  const isPortal = grupo.fonteDescricao === "portal";
  // Proveniencia da lista: 'deterministico' = lida por parser (tabela DOCX/XLSX,
  // nao passou pela Lia); senao = estruturada pela Lia (LLM). Uma lista e
  // homogenea na pratica; basta haver algum item deterministico para marcar.
  const deterministica =
    grupo.itens.length > 0 && grupo.itens.every((it) => it.itemOrigem === "deterministico");
  return (
    <div className="cell-stack">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="tag">{grupo.listaOrigem}</span>
        <span
          className="tag"
          title={
            deterministica
              ? "Lista lida por parser de tabela (não passou pela Lia)."
              : "Lista estruturada pela Lia (extração por IA)."
          }
        >
          {deterministica ? "determinístico" : "extraído pela Lia"}
        </span>
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
          {grupo.itens.map((it, i) => (
            <tr key={it.id || `${it.itemNumero ?? ""}-${it.ordem ?? i}`}>
              <td className="sub tnum">
                {it.itemNumero || (it.ordem != null ? `${it.ordem}` : "—")}
              </td>
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
              <td className="sub tnum">
                {it.quantidade != null ? formatNumber(it.quantidade) : "—"}
              </td>
              <td className="sub tnum">
                {it.precoReferencia != null ? formatCurrency(it.precoReferencia) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Bloco de um documento: cabecalho (arquivo + status) e suas listas. */
function DocumentoBloco({ doc, itens }: { doc: AvisoDocumento; itens: AvisoItem[] }) {
  const grupos = useMemo(() => agruparPorLista(itens), [itens]);
  return (
    <div className="card cell-stack">
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
      {grupos.length > 0 ? (
        grupos.map((g) => <ListaTabela key={g.listaOrigem} grupo={g} />)
      ) : (
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
 * Grifa em <mark> os termos que o Effecti casou (palavra-chave) dentro de um
 * texto. Casamento literal case-insensitive; constroi nodes React (sem HTML cru,
 * a salvo de XSS). Termos maiores primeiro para nao quebrar match sobreposto.
 */
function realcarTermos(texto: string, termos: string[]): ReactNode {
  const alvos = [...new Set(termos.map((t) => t.trim()).filter((t) => t.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (alvos.length === 0) return texto;
  const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${alvos.map(escapar).join("|")})`, "gi");
  const alvoLower = new Set(alvos.map((a) => a.toLowerCase()));
  return texto.split(re).map((parte, i) =>
    alvoLower.has(parte.toLowerCase()) ? (
      <mark key={i} className="hl-effecti">
        {parte}
      </mark>
    ) : (
      <Fragment key={i}>{parte}</Fragment>
    ),
  );
}

/**
 * ListaPortal — a lista COMPLETA do painel Effecti (/all, aviso_itens_portal).
 * Fonte unica por aviso, descricao GENERICA do portal (NAO confiavel; serve de
 * contagem/numeracao, nunca de descricao boa). Sem preco (o /all vem zerado).
 * Mostra coluna Lote so quando o edital divide por lotes.
 */
function ListaPortal({ itens }: { itens: AvisoItemPortal[] }) {
  const temLote = useMemo(() => itens.some((i) => i.lote != null && i.lote !== ""), [itens]);
  // Itens destacados pelo Effecti (palavra-chave) primeiro. Dentro de cada grupo,
  // ordena numericamente por (lote, item) -- lote vem texto do banco, ordenacao
  // lexicografica (1, 10, 11, 2); lote nao-numerico cai no fim por nome.
  const ordenados = useMemo(() => {
    const loteChave = (lote: string | null): [number, string] => {
      const n = Number((lote ?? "").trim());
      return Number.isFinite(n) && lote != null && lote !== "" ? [n, ""] : [Number.POSITIVE_INFINITY, lote ?? ""];
    };
    return [...itens].sort((a, b) => {
      if (a.effecti !== b.effecti) return a.effecti ? -1 : 1;
      const [na, sa] = loteChave(a.lote);
      const [nb, sb] = loteChave(b.lote);
      if (na !== nb) return na - nb;
      if (sa !== sb) return sa.localeCompare(sb);
      return a.itemNumero - b.itemNumero;
    });
  }, [itens]);
  if (itens.length === 0) {
    return (
      <div className="tbl-wrap">
        <div className="empty">
          <h4>Lista Effecti ainda não coletada.</h4>
          <p>Dispare a coleta do painel (/all) para materializar a lista completa deste aviso.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="card cell-stack">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="tag">painel Effecti (/all)</span>
        <span className="sub">descrição genérica do portal (não confiável)</span>
      </div>
      <table>
        <thead>
          <tr>
            {temLote ? <th>Lote</th> : null}
            <th>Item</th>
            <th>Descrição</th>
            <th>Unid.</th>
            <th>Qtd.</th>
          </tr>
        </thead>
        <tbody>
          {ordenados.map((it, i) => (
            <tr key={`${it.lote ?? ""}-${it.itemNumero}-${i}`}>
              {temLote ? <td className="sub tnum">{it.lote || "—"}</td> : null}
              <td className="sub tnum">{it.itemNumero}</td>
              <td>
                {it.effecti ? realcarTermos(it.descricao, it.effectiTermos) : it.descricao}
                {it.effecti ? (
                  <>
                    {" "}
                    <span className="tag effecti" title="Item destacado pelo Effecti (casou palavra-chave do perfil).">
                      Effecti
                    </span>
                  </>
                ) : null}
              </td>
              <td className="sub tnum">{it.unidade || "—"}</td>
              <td className="sub tnum">
                {it.quantidade != null ? formatNumber(it.quantidade) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Cabecalho da tela: metadados do aviso (vindos da linha; opcionais no deep-link). */
interface AvisoMeta {
  orgao?: string;
  uf?: string;
  edital?: string;
  effecti?: string;
}

/**
 * cmp-lista-itens-extraidos — Tela dedicada navegavel da lista de itens
 * extraidos de um aviso. Mostra SOMENTE a extracao (por documento, por lista,
 * listas nunca fundidas), fiel ao que a Lia gravou em documento_itens. SO
 * LEITURA: triagem (veredito, recall, match contra catalogo) vive a parte.
 */
export function ListaItensExtraidos({
  avisoId,
  meta,
}: {
  avisoId: string;
  meta: AvisoMeta;
}) {
  const { data, isLoading, isError, error } = useAvisoItens(avisoId, true);
  const coletar = useColetarItensPortal(avisoId);

  // Filtro de origem: listas do EDITAL (confiaveis, por arquivo) vs lista
  // EFFECTI (/all do painel, listada mas nao confiavel). Default = edital.
  const [view, setView] = useState<"edital" | "effecti">("edital");

  // Documento ativo na visao por arquivo (abas). Guardamos so o id; o ativo
  // efetivo cai no primeiro documento quando o id ainda nao foi escolhido ou
  // some da lista (recarga). Default = primeiro arquivo.
  const [docAtivoId, setDocAtivoId] = useState<string | null>(null);

  // Effecti vai separado do texto para virar link (abre o aviso no painel Effecti).
  const subtituloTexto = useMemo(() => {
    const partes: string[] = [];
    if (meta.orgao) partes.push(meta.uf ? `${meta.orgao} / ${meta.uf}` : meta.orgao);
    if (meta.edital) partes.push(`Edital ${meta.edital}`);
    return partes.join(" · ");
  }, [meta]);
  const temSubtitulo = subtituloTexto !== "" || meta.effecti != null;

  const documentos = useMemo(() => data?.documentos ?? [], [data]);
  const itens = useMemo(() => data?.itens ?? [], [data]);
  const itensPortal = useMemo(() => data?.itensPortal ?? [], [data]);

  const itensPorDoc = useMemo(() => {
    const m = new Map<string, AvisoItem[]>();
    for (const it of itens) {
      const list = m.get(it.documentoId) ?? [];
      list.push(it);
      m.set(it.documentoId, list);
    }
    return m;
  }, [itens]);

  // Documento da aba ativa: o id escolhido, com fallback no primeiro arquivo.
  const docAtivo = useMemo(
    () => documentos.find((d) => d.documentoId === docAtivoId) ?? documentos[0],
    [documentos, docAtivoId],
  );

  // Contagem do segmento ativo (edital = itens do arquivo aberto; effecti = /all).
  const total =
    view === "effecti"
      ? itensPortal.length
      : docAtivo
        ? (itensPorDoc.get(docAtivo.documentoId) ?? []).length
        : 0;

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <Link
            href="/automacao/avisos"
            className="link"
            style={{ fontSize: "12.5px", marginBottom: 8 }}
          >
            <ChevronLeft aria-hidden="true" />
            Voltar à triagem
          </Link>
          <h2>Lista de itens extraídos</h2>
          {temSubtitulo ? (
            <p>
              {subtituloTexto}
              {meta.effecti ? (
                <>
                  {subtituloTexto ? " · " : ""}
                  Effecti{" "}
                  <a
                    href={`https://minha.effecti.com.br/#/aviso-edital-minhas/${meta.effecti}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Abrir este aviso no painel Effecti"
                  >
                    {meta.effecti}
                  </a>
                </>
              ) : null}
            </p>
          ) : (
            <p className="mono">{avisoId}</p>
          )}
        </div>
        {!isLoading && !isError ? (
          <div className="actions" style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div
              className="filter-group segmented"
              role="group"
              aria-label="Filtrar por origem da lista"
            >
              <button
                type="button"
                className={cn("btn", "btn-sm", view === "edital" && "btn-primary")}
                aria-pressed={view === "edital"}
                onClick={() => setView("edital")}
              >
                Listas do edital
              </button>
              <button
                type="button"
                className={cn("btn", "btn-sm", view === "effecti" && "btn-primary")}
                aria-pressed={view === "effecti"}
                onClick={() => setView("effecti")}
              >
                Lista Effecti
              </button>
            </div>
            {view === "effecti" && meta.effecti ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={coletar.isPending}
                onClick={() => coletar.mutate(meta.effecti as string)}
                title="Coleta a lista completa do painel Effecti (/all) e substitui o snapshot deste aviso."
              >
                {coletar.isPending ? "Coletando…" : "Coletar do painel"}
              </button>
            ) : null}
            {view === "effecti" && coletar.isError ? (
              <span className="sub" style={{ color: "var(--err)" }}>
                {coletar.error instanceof Error ? coletar.error.message : "Falha ao coletar."}
              </span>
            ) : null}
            <span className="count">
              {total} {total === 1 ? "item" : "itens"}
            </span>
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <div className="card">
          {Array.from({ length: 4 }).map((_, r) => (
            <span
              key={r}
              className="skel skel-line"
              style={{ display: "block", margin: "10px 0", width: `${60 + (r % 3) * 12}%` }}
            />
          ))}
        </div>
      ) : isError ? (
        <div className="tbl-wrap">
          <div className="empty">
            <h4>Não foi possível carregar os itens</h4>
            <p>{error instanceof Error ? error.message : "Tente novamente em instantes."}</p>
          </div>
        </div>
      ) : view === "effecti" ? (
        <ListaPortal itens={itensPortal} />
      ) : documentos.length === 0 ? (
        <div className="tbl-wrap">
          <div className="empty">
            <h4>Nenhum documento com texto para extrair itens.</h4>
            <p>Quando a Lia extrair os itens do edital, eles aparecem aqui.</p>
          </div>
        </div>
      ) : (
        <Fragment>
          <div
            className="filter-group segmented"
            role="tablist"
            aria-label="Arquivo do edital"
            style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "4px 0 16px" }}
          >
            {documentos.map((doc) => {
              const ativo = docAtivo?.documentoId === doc.documentoId;
              return (
                <button
                  key={doc.documentoId}
                  type="button"
                  role="tab"
                  aria-selected={ativo}
                  className={cn("btn", "btn-sm", ativo && "btn-primary")}
                  onClick={() => setDocAtivoId(doc.documentoId)}
                  title={doc.nomeArquivo || doc.documentoId}
                >
                  {doc.nomeArquivo || doc.documentoId}
                </button>
              );
            })}
          </div>
          {docAtivo ? (
            <DocumentoBloco
              key={docAtivo.documentoId}
              doc={docAtivo}
              itens={itensPorDoc.get(docAtivo.documentoId) ?? []}
            />
          ) : null}
        </Fragment>
      )}
    </section>
  );
}
