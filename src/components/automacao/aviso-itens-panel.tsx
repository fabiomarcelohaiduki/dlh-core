"use client";

import { useMemo } from "react";
import type { AvisoDocumento, AvisoItem, ItensStatus } from "@/lib/api/types";
import { formatCurrency, formatNumber } from "@/lib/format";
import { useAvisoItens } from "@/hooks/use-aviso-itens";

/** Rotulo legivel do estado de extracao de itens de um documento. */
const STATUS_LABEL: Record<ItensStatus, string> = {
  pendente: "Aguardando a Lia",
  extraido: "Itens extraídos",
  sem_itens: "Sem itens",
  erro: "Erro na extração",
  inobtenivel: "Texto indisponível",
  ignorado: "Ignorado",
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
            <tr key={`${it.itemNumero ?? ""}-${it.ordem ?? i}`}>
              <td className="sub tnum">{it.itemNumero || (it.ordem != null ? `${it.ordem}` : "—")}</td>
              <td>{it.descricao}</td>
              <td className="sub tnum">{it.unidade || "—"}</td>
              <td className="sub tnum">{it.quantidade != null ? formatNumber(it.quantidade) : "—"}</td>
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

function DocumentoBloco({ doc, itens }: { doc: AvisoDocumento; itens: AvisoItem[] }) {
  const grupos = useMemo(() => agruparPorLista(itens), [itens]);
  return (
    <div className="cell-stack">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong>{doc.nomeArquivo || doc.documentoId}</strong>
        <span className="tag">{STATUS_LABEL[doc.itensStatus] ?? doc.itensStatus}</span>
      </div>
      {grupos.length > 0
        ? grupos.map((g) => <ListaTabela key={g.listaOrigem} grupo={g} />)
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
  if (documentos.length === 0) {
    return <span className="sub">Nenhum documento com texto para extrair itens.</span>;
  }

  const itensPorDoc = new Map<string, AvisoItem[]>();
  for (const it of itens) {
    const list = itensPorDoc.get(it.documentoId) ?? [];
    list.push(it);
    itensPorDoc.set(it.documentoId, list);
  }

  return (
    <div className="cell-stack" style={{ gap: 16 }}>
      {documentos.map((doc) => (
        <DocumentoBloco key={doc.documentoId} doc={doc} itens={itensPorDoc.get(doc.documentoId) ?? []} />
      ))}
    </div>
  );
}
