"use client";

import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Printer, TriangleAlert } from "lucide-react";
import { useConfigEmpresa } from "@/hooks/use-config-empresa";
import { useLinhas } from "@/hooks/use-linhas";
import { useDocumentosDados } from "@/hooks/use-documentos-dados";
import { useTabelasPrecos } from "@/hooks/use-tabela-precos";
import { formatDate } from "@/lib/format";
import type {
  AtributoTipo,
  DocAtributo,
  DocumentoLinhaDados,
  DocumentoProduto,
  DocumentoSku,
  Regiao,
  TabelaPrecoCelula,
  TabelaPrecoConsolidada,
} from "@/lib/api/types";

const REGIAO_LABEL: Record<Regiao, string> = {
  S: "Sul",
  SE: "Sudeste",
  CO: "Centro-Oeste",
  NE: "Nordeste",
  N: "Norte",
};

const REGIOES_ORDEM: Regiao[] = ["S", "SE", "CO", "NE", "N"];

const NUM2 = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Valor monetario compacto (sem "R$", 2 casas); null -> "—". */
function num(v: number | null): string {
  return v == null ? "—" : NUM2.format(v);
}

/** Valor da celula se vigente; senao null. */
function valorCelula(cell: TabelaPrecoCelula | undefined): number | null {
  if (cell && cell.estado === "vigente" && cell.valor != null) return cell.valor;
  return null;
}

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
  // Filtro opcional de produtos: presente so quando o usuario excluiu algum no
  // modal. Ausente => imprime todos os produtos das linhas.
  const produtoFilter = useMemo(() => {
    const raw = params.get("produtos");
    if (raw == null) return null;
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  }, [params]);

  // Precos opcionais por SKU: ligados quando precos=1; as regioes seguem a
  // ordem canonica (S, SE, ...) restritas as escolhidas no modal.
  const incluirPrecos = params.get("precos") === "1";
  const regioes = useMemo(() => {
    if (!incluirPrecos) return [] as Regiao[];
    const sel = new Set(
      (params.get("regioes") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    );
    return REGIOES_ORDEM.filter((r) => sel.has(r));
  }, [incluirPrecos, params]);

  const empresa = useConfigEmpresa();
  const linhas = useLinhas();
  const dados = useDocumentosDados(linhaIds);
  const tabelas = useTabelasPrecos(incluirPrecos ? linhaIds : []);

  const nomePorLinha = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of linhas.data?.items ?? []) map.set(l.id, l.nome);
    return map;
  }, [linhas.data]);

  // Indice sku_id -> celulas de preco, agregado de todas as linhas.
  const precosPorSku = useMemo(() => {
    const map = new Map<string, TabelaPrecoCelula[]>();
    if (!incluirPrecos) return map;
    for (const t of tabelas) {
      const data = t.data as TabelaPrecoConsolidada | undefined;
      for (const p of data?.produtos ?? []) {
        for (const s of p.skus) map.set(s.sku_id, s.precos);
      }
    }
    return map;
  }, [incluirPrecos, tabelas]);

  const carregando =
    empresa.isLoading ||
    linhas.isLoading ||
    dados.some((d) => d.isLoading) ||
    (incluirPrecos && tabelas.some((t) => t.isLoading));
  const erro =
    empresa.isError ||
    linhas.isError ||
    dados.some((d) => d.isError) ||
    (incluirPrecos && tabelas.some((t) => t.isError));

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

  // Cada card = um SKU. Produto sem SKU vira um card unico (sku = null) com os
  // valores uniformes do Produto.
  const renderCard = (
    atributosLinha: DocAtributo[],
    produto: DocumentoProduto,
    sku: DocumentoSku | null,
  ) => {
    // Atributos da Linha (valor herdado em sku.atributos; cai para o valor
    // uniforme do Produto se o SKU nao o materializou ou inexiste).
    const doLinha = atributosLinha
      .filter((a) => a.mostra_catalogo)
      .map((a) => ({
        chave: a.chave,
        valor: formatAttr(a.tipo, sku?.atributos?.[a.chave] ?? produto.atributos?.[a.chave]),
      }));
    // Atributos PROPRIOS do Produto variam por SKU -> so vem de sku.atributos.
    const doProduto = (sku ? produto.atributos_produto : [])
      .filter((a) => a.mostra_catalogo)
      .map((a) => ({ chave: a.chave, valor: formatAttr(a.tipo, sku?.atributos?.[a.chave]) }));
    const visiveis = [...doLinha, ...doProduto].filter((x) => x.valor !== "—");
    const fotoUrl = sku?.foto_url ?? produto.foto_url;
    // Precos do SKU por regiao (CIF Minimo - CIF Alvo), so quando habilitado.
    const precosRegiao =
      incluirPrecos && sku
        ? regioes
            .map((r) => {
              const cells = precosPorSku.get(sku.id) ?? [];
              const min = valorCelula(
                cells.find((c) => c.regiao === r && c.patamar === "CIF_MINIMO"),
              );
              const alvo = valorCelula(
                cells.find((c) => c.regiao === r && c.patamar === "CIF_ALVO"),
              );
              return { regiao: r, min, alvo };
            })
            .filter((x) => x.min != null || x.alvo != null)
        : [];
    return (
      <article key={sku ? sku.id : produto.id} className="cat-card">
        <div className="cat-card-foto">
          {fotoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fotoUrl} alt={produto.nome} />
          ) : (
            <span className="cat-card-foto-vazia">Sem imagem</span>
          )}
        </div>
        <div className="cat-card-body">
          <h4 className="cat-card-nome">{produto.nome}</h4>
          {sku ? <span className="cat-card-sku">{sku.codigo_sku}</span> : null}
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
          {precosRegiao.length > 0 ? (
            <table className="cat-card-precos">
              <thead>
                <tr>
                  <th>Região</th>
                  <th>Mínimo</th>
                  <th>Alvo</th>
                </tr>
              </thead>
              <tbody>
                {precosRegiao.map((p) => (
                  <tr key={p.regiao}>
                    <td>{REGIAO_LABEL[p.regiao]}</td>
                    <td className="mono">{num(p.min)}</td>
                    <td className="mono">{num(p.alvo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
          {/* Tabela so para o efeito de cabecalho corrido: o <thead> e repetido
              pelo navegador no topo de CADA pagina impressa (mesmo padrao da
              Tabela de Precos). O conteudo flui no unico <td> do <tbody>. */}
          <table className="cat-doc">
            <thead>
              <tr>
                <td>
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
                </td>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  {linhaIds.map((linhaId, i) => {
                    const data = dados[i]?.data as DocumentoLinhaDados | undefined;
                    const nome = nomePorLinha.get(linhaId) ?? data?.linha.nome ?? "Linha";
                    const produtos = (data?.produtos ?? []).filter(
                      (p) => !produtoFilter || produtoFilter.has(p.id),
                    );
                    const atributosLinha = data?.atributos_linha ?? [];

                    return (
                      <section key={linhaId} className="cat-linha">
                        <h3 className="print-linha-nome">{nome}</h3>
                        {produtos.length === 0 ? (
                          <div className="print-vazio">Nenhum produto ativo nesta linha.</div>
                        ) : (
                          <div className="cat-grid">
                            {produtos.flatMap((produto) =>
                              produto.skus.length === 0
                                ? [renderCard(atributosLinha, produto, null)]
                                : produto.skus.map((sku) =>
                                    renderCard(atributosLinha, produto, sku),
                                  ),
                            )}
                          </div>
                        )}
                      </section>
                    );
                  })}

                  {e?.observacaoRodape ? (
                    <footer className="print-foot">{e.observacaoRodape}</footer>
                  ) : null}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
