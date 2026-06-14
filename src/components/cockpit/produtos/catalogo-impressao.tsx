"use client";

import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Printer, TriangleAlert } from "lucide-react";
import { useConfigEmpresa } from "@/hooks/use-config-empresa";
import { useLinhas } from "@/hooks/use-linhas";
import { useDocumentosDados } from "@/hooks/use-documentos-dados";
import { formatDate } from "@/lib/format";
import type {
  AtributoTipo,
  DocAtributo,
  DocumentoLinhaDados,
  DocumentoProduto,
} from "@/lib/api/types";

/** Valor de atributo formatado para o documento; vazio -> "—". */
function formatAttr(tipo: AtributoTipo, value: unknown): string {
  if (value == null || value === "") return "—";
  if (tipo === "booleano") {
    // O JSONB livre pode guardar boolean nativo OU string "true"/"false".
    if (value === false || value === "false") return "Não";
    return "Sim";
  }
  return String(value);
}

/**
 * cmp-catalogo-impressao — documento imprimivel do Catalogo de produtos. Cada
 * produto vira um card (grade de 2 colunas) com foto, nome, descricao e os
 * atributos da Linha marcados como "aparece no catalogo" (valor uniforme em
 * produto.atributos). Sem preco. Os cards fluem por todas as paginas; cada um e
 * indivisivel (break-inside:avoid). Le a selecao (linhas) da query, monta o
 * cabecalho institucional (config_empresa) + logo e dispara window.print ao
 * carregar. Estilo de papel claro, alheio ao tema escuro.
 */
export function CatalogoImpressao() {
  const params = useSearchParams();
  const linhaIds = useMemo(
    () => (params.get("linhas") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    [params],
  );

  const empresa = useConfigEmpresa();
  const linhas = useLinhas();
  const dados = useDocumentosDados(linhaIds);

  const nomePorLinha = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of linhas.data?.items ?? []) map.set(l.id, l.nome);
    return map;
  }, [linhas.data]);

  const carregando =
    empresa.isLoading || linhas.isLoading || dados.some((d) => d.isLoading);
  const erro = empresa.isError || linhas.isError || dados.some((d) => d.isError);

  const printDisparado = useRef(false);
  useEffect(() => {
    if (carregando || erro || printDisparado.current) return;
    printDisparado.current = true;
    const id = window.setTimeout(() => window.print(), 350);
    return () => window.clearTimeout(id);
  }, [carregando, erro]);

  if (linhaIds.length === 0) {
    return (
      <div style={{ padding: 40, color: "#b91c1c" }}>
        Seleção inválida. Volte ao cockpit e gere o catálogo novamente.
      </div>
    );
  }

  const e = empresa.data;
  const titulo = e?.nomeFantasia || e?.razaoSocial || "Catálogo";

  const cabecalho = (
    <header className="print-head">
      <div className="print-brand">
        {e?.logoBase64 ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={e.logoBase64} alt="Logomarca" className="print-logo" />
        ) : null}
        <div>
          <h1>{e?.razaoSocial || titulo}</h1>
          {e?.nomeFantasia && e?.razaoSocial ? (
            <div className="print-fantasia">{e.nomeFantasia}</div>
          ) : null}
        </div>
      </div>
      <div className="print-empresa">
        {e?.cnpj ? <div>CNPJ: {e.cnpj}</div> : null}
        {e?.inscricaoEstadual ? <div>IE: {e.inscricaoEstadual}</div> : null}
        {e?.endereco ? <div>{e.endereco}</div> : null}
        {e?.telefone ? <div>{e.telefone}</div> : null}
        {e?.email ? <div>{e.email}</div> : null}
        {e?.site ? <div>{e.site}</div> : null}
      </div>
    </header>
  );

  const renderCard = (
    atributosLinha: DocAtributo[],
    produto: DocumentoProduto,
  ) => {
    // So os atributos da Linha visiveis no catalogo, com valor preenchido.
    const visiveis = atributosLinha
      .filter((a) => a.mostra_catalogo)
      .map((a) => ({ chave: a.chave, valor: formatAttr(a.tipo, produto.atributos?.[a.chave]) }))
      .filter((x) => x.valor !== "—");
    return (
      <article key={produto.id} className="cat-card">
        <div className="cat-card-foto">
          {produto.foto_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={produto.foto_url} alt={produto.nome} />
          ) : (
            <span className="cat-card-foto-vazia">Sem imagem</span>
          )}
        </div>
        <div className="cat-card-body">
          <h4 className="cat-card-nome">{produto.nome}</h4>
          {produto.descricao ? (
            <p className="cat-card-desc">{produto.descricao}</p>
          ) : null}
          {visiveis.length > 0 ? (
            <dl className="cat-card-attrs">
              {visiveis.map((x) => (
                <div key={x.chave} className="cat-attr">
                  <dt>{x.chave}</dt>
                  <dd>{x.valor}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {produto.skus.length > 0 ? (
            <div className="cat-card-skus">
              <span className="cat-card-skus-label">Variações</span>
              <span className="cat-card-skus-list">
                {produto.skus.map((s) => s.codigo_sku).join(" · ")}
              </span>
            </div>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <div className="print-doc">
      <div className="print-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          <Printer aria-hidden="true" />
          <span>Imprimir / Salvar PDF</span>
        </button>
        {carregando ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Loader2 className="spin" aria-hidden="true" /> Carregando dados…
          </span>
        ) : null}
      </div>

      {erro ? (
        <div style={{ padding: 40, color: "#b91c1c", display: "flex", gap: 8 }}>
          <TriangleAlert aria-hidden="true" />
          Não foi possível carregar os dados do catálogo.
        </div>
      ) : (
        <div className="print-page">
          {cabecalho}
          <div className="print-title">
            <div className="print-title-text">
              <h2>Catálogo</h2>
            </div>
            <div className="print-meta">
              <span className="print-meta-label">Emissão</span>
              <span className="print-meta-value">
                {formatDate(new Date().toISOString())}
              </span>
            </div>
          </div>

          {linhaIds.map((linhaId, i) => {
            const data = dados[i]?.data as DocumentoLinhaDados | undefined;
            const nome = nomePorLinha.get(linhaId) ?? data?.linha.nome ?? "Linha";
            const produtos = data?.produtos ?? [];
            const atributosLinha = data?.atributos_linha ?? [];

            return (
              <section key={linhaId} className="cat-linha">
                <h3 className="print-linha-nome">{nome}</h3>
                {produtos.length === 0 ? (
                  <div className="print-vazio">Nenhum produto ativo nesta linha.</div>
                ) : (
                  <div className="cat-grid">
                    {produtos.map((produto) => renderCard(atributosLinha, produto))}
                  </div>
                )}
              </section>
            );
          })}

          {e?.observacaoRodape ? (
            <footer className="print-foot">{e.observacaoRodape}</footer>
          ) : null}
        </div>
      )}
    </div>
  );
}
