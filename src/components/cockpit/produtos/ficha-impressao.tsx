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
  DocumentoLinhaDados,
  DocumentoProduto,
  DocumentoSku,
  SkuTipoOrigem,
} from "@/lib/api/types";

const ORIGEM_LABEL: Record<SkuTipoOrigem, string> = {
  fabricado: "Fabricado",
  comprado: "Revenda",
};

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

/** Dimensoes (Record arbitrario) -> "chave: valor · chave: valor"; vazio -> "—". */
function formatDimensoes(dim: Record<string, unknown> | null): string {
  if (!dim) return "—";
  const partes = Object.entries(dim)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}: ${String(v)}`);
  return partes.length > 0 ? partes.join(" · ") : "—";
}

/** Uma ficha = um SKU, achatado com o produto e os atributos de origem. */
interface FichaItem {
  linhaNome: string;
  produto: DocumentoProduto;
  sku: DocumentoSku;
  atributos: { chave: string; valor: string }[];
}

/**
 * cmp-ficha-impressao — documento imprimivel das Fichas Tecnicas. Cada SKU das
 * Linhas escolhidas vira uma ficha em pagina propria, com cabecalho
 * institucional repetido, foto, dados tecnicos (origem, dimensoes, acabamento,
 * peso, tolerancia) e os atributos (Linha + Produto) marcados como "aparece na
 * ficha tecnica", lidos do schema mesclado do SKU. Sem preco. Le a selecao
 * (linhas) da query e dispara window.print ao carregar. Papel claro.
 */
export function FichaImpressao() {
  const params = useSearchParams();
  const linhaIds = useMemo(
    () => (params.get("linhas") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    [params],
  );
  // Filtro opcional de produtos: presente so quando o usuario excluiu algum no
  // modal. Ausente => imprime as fichas de todos os produtos das linhas.
  const produtoFilter = useMemo(() => {
    const raw = params.get("produtos");
    if (raw == null) return null;
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  }, [params]);

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

  // Achata todas as Linhas -> Produtos -> SKUs em uma lista linear de fichas,
  // preservando a ordem da selecao. Cada SKU resolve seus atributos visiveis
  // (Linha + Produto) contra o schema mesclado guardado em sku.atributos.
  // Calculo direto no render (barato): React Query troca a referencia de `dados`
  // a cada atualizacao, entao memoiza-lo so adicionaria fragilidade de deps.
  const fichas: FichaItem[] = [];
  linhaIds.forEach((linhaId, i) => {
    const data = dados[i]?.data as DocumentoLinhaDados | undefined;
    if (!data) return;
    const linhaNome = nomePorLinha.get(linhaId) ?? data.linha.nome ?? "Linha";
    for (const produto of data.produtos) {
      if (produtoFilter && !produtoFilter.has(produto.id)) continue;
      const visiveisLinha = data.atributos_linha.filter((a) => a.mostra_ficha);
      const visiveisProduto = produto.atributos_produto.filter((a) => a.mostra_ficha);
      for (const sku of produto.skus) {
        // Atributos da Linha: valor herdado deve estar materializado em
        // sku.atributos, mas SKUs legados podem nao te-lo -> cai para o valor
        // uniforme do Produto (produto.atributos). Atributos PROPRIOS do
        // Produto variam por SKU, entao vem apenas de sku.atributos.
        const doLinha = visiveisLinha.map((a) => ({
          chave: a.chave,
          valor: formatAttr(a.tipo, sku.atributos?.[a.chave] ?? produto.atributos?.[a.chave]),
        }));
        const doProduto = visiveisProduto.map((a) => ({
          chave: a.chave,
          valor: formatAttr(a.tipo, sku.atributos?.[a.chave]),
        }));
        const atributos = [...doLinha, ...doProduto].filter((x) => x.valor !== "—");
        fichas.push({ linhaNome, produto, sku, atributos });
      }
    }
  });

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
        Seleção inválida. Volte ao cockpit e gere a ficha novamente.
      </div>
    );
  }

  const e = empresa.data;
  const titulo = e?.nomeFantasia || e?.razaoSocial || "Ficha técnica";

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
          Não foi possível carregar os dados das fichas técnicas.
        </div>
      ) : fichas.length === 0 && !carregando ? (
        <div className="print-page">
          {cabecalho}
          <div className="print-vazio">Nenhum SKU cadastrado nas linhas selecionadas.</div>
        </div>
      ) : (
        <div className="print-page">
          {fichas.map((f) => {
            const fotoUrl = f.sku.foto_url ?? f.produto.foto_url;
            return (
              <section key={f.sku.id} className="ficha">
                {cabecalho}
                <div className="print-title">
                  <div className="print-title-text">
                    <h2>Ficha técnica</h2>
                  </div>
                  <div className="print-meta">
                    <span className="print-meta-label">Emissão</span>
                    <span className="print-meta-value">
                      {formatDate(new Date().toISOString())}
                    </span>
                  </div>
                </div>

                <div className="ficha-id">
                  <span className="ficha-linha">{f.linhaNome}</span>
                  <h3 className="ficha-produto">{f.produto.nome}</h3>
                  <span className="ficha-sku">{f.sku.codigo_sku}</span>
                </div>

                <div className="ficha-corpo">
                  <div className="ficha-foto">
                    {fotoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={fotoUrl} alt={f.produto.nome} />
                    ) : (
                      <span className="ficha-foto-vazia">Sem imagem</span>
                    )}
                  </div>

                  <div className="ficha-dados">
                    <dl className="ficha-specs">
                      <div className="ficha-spec">
                        <dt>Origem</dt>
                        <dd>{ORIGEM_LABEL[f.sku.tipo_origem]}</dd>
                      </div>
                      <div className="ficha-spec">
                        <dt>Dimensões</dt>
                        <dd>{formatDimensoes(f.sku.dimensoes)}</dd>
                      </div>
                      {f.sku.acabamento ? (
                        <div className="ficha-spec">
                          <dt>Acabamento</dt>
                          <dd>{f.sku.acabamento}</dd>
                        </div>
                      ) : null}
                      {f.sku.peso_gr != null ? (
                        <div className="ficha-spec">
                          <dt>Peso</dt>
                          <dd>{f.sku.peso_gr} g</dd>
                        </div>
                      ) : null}
                      {f.sku.tolerancia_pct != null ? (
                        <div className="ficha-spec">
                          <dt>Tolerância</dt>
                          <dd>{f.sku.tolerancia_pct}%</dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                </div>

                {f.produto.descricao ? (
                  <p className="ficha-desc">{f.produto.descricao}</p>
                ) : null}

                {f.atributos.length > 0 ? (
                  <div className="ficha-attrs">
                    <h4 className="ficha-attrs-titulo">Especificações</h4>
                    <table className="ficha-attrs-table">
                      <tbody>
                        {f.atributos.map((a) => (
                          <tr key={a.chave}>
                            <th>{a.chave}</th>
                            <td>{a.valor}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {e?.observacaoRodape ? (
                  <footer className="print-foot">{e.observacaoRodape}</footer>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
