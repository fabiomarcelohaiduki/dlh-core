"use client";

import { Fragment, useMemo } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { AvisoDocumento, AvisoItem, ItensStatus } from "@/lib/api/types";
import { formatCurrency, formatNumber } from "@/lib/format";
import { useAvisoItens } from "@/hooks/use-aviso-itens";

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

  const subtitulo = useMemo(() => {
    const partes: string[] = [];
    if (meta.orgao) partes.push(meta.uf ? `${meta.orgao} / ${meta.uf}` : meta.orgao);
    if (meta.edital) partes.push(`Edital ${meta.edital}`);
    if (meta.effecti) partes.push(`Effecti ${meta.effecti}`);
    return partes.join(" · ");
  }, [meta]);

  const documentos = data?.documentos ?? [];
  const itens = useMemo(() => data?.itens ?? [], [data]);

  const itensPorDoc = useMemo(() => {
    const m = new Map<string, AvisoItem[]>();
    for (const it of itens) {
      const list = m.get(it.documentoId) ?? [];
      list.push(it);
      m.set(it.documentoId, list);
    }
    return m;
  }, [itens]);

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
          {subtitulo ? <p>{subtitulo}</p> : <p className="mono">{avisoId}</p>}
        </div>
        {!isLoading && !isError ? (
          <div className="actions">
            <span className="count">
              {itens.length} {itens.length === 1 ? "item" : "itens"}
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
      ) : documentos.length === 0 ? (
        <div className="tbl-wrap">
          <div className="empty">
            <h4>Nenhum documento com texto para extrair itens.</h4>
            <p>Quando a Lia extrair os itens do edital, eles aparecem aqui.</p>
          </div>
        </div>
      ) : (
        <Fragment>
          {documentos.map((doc) => (
            <DocumentoBloco
              key={doc.documentoId}
              doc={doc}
              itens={itensPorDoc.get(doc.documentoId) ?? []}
            />
          ))}
        </Fragment>
      )}
    </section>
  );
}
