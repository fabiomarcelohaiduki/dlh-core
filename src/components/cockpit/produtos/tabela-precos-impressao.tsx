"use client";

import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Printer, TriangleAlert } from "lucide-react";
import { useConfigEmpresa } from "@/hooks/use-config-empresa";
import { DlhLogo } from "@/components/cockpit/dlh-logo";
import { useLinhas } from "@/hooks/use-linhas";
import { useTabelasPrecos } from "@/hooks/use-tabela-precos";
import { formatDate } from "@/lib/format";
import type {
  Regiao,
  TabelaPrecoCelula,
  TabelaPrecoConsolidada,
  TabelaPrecoSku,
} from "@/lib/api/types";

const REGIAO_LABEL: Record<Regiao, string> = {
  S: "Sul",
  SE: "Sudeste",
  CO: "Centro-Oeste",
  NE: "Nordeste",
  N: "Norte",
};

const REGIOES_ORDEM: Regiao[] = ["S", "SE", "CO", "NE", "N"];

type Coluna = "fob" | "ll";
const COLUNAS_ORDEM: Coluna[] = ["fob", "ll"];

const NUM2 = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const PCT = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

/** Le um parametro de lista (csv) da query, filtrando contra os validos. */
function lerLista<T extends string>(raw: string | null, validos: readonly T[]): T[] {
  if (!raw) return [];
  const set = new Set<string>(validos);
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => set.has(s));
}

/** Indexa as celulas de um SKU por `regiao-patamar`. */
function indexar(precos: TabelaPrecoCelula[]) {
  const map = new Map<string, TabelaPrecoCelula>();
  for (const c of precos) map.set(`${c.regiao}-${c.patamar}`, c);
  return map;
}

/** Valor da celula se vigente; senao null. */
function valor(cell: TabelaPrecoCelula | undefined): number | null {
  if (cell && cell.estado === "vigente" && cell.valor != null) return cell.valor;
  return null;
}

/** Numero monetario compacto (sem "R$", 2 casas); null -> "—". */
function num(v: number | null): string {
  return v == null ? "—" : NUM2.format(v);
}

/** LL% do produto (lucro alvo, armazenado em pontos percentuais). */
function pct(v: number | null): string {
  return v == null ? "—" : `${PCT.format(v)}%`;
}

/** FOB do SKU (independe de regiao): pega a primeira celula FOB vigente. */
function fob(precos: TabelaPrecoCelula[]): number | null {
  const c = precos.find(
    (x) => x.patamar === "FOB" && x.estado === "vigente" && x.valor != null,
  );
  return c?.valor ?? null;
}

/**
 * Preco-base do SKU para ordenacao crescente: FOB; na falta dele, o menor CIF
 * vigente (alvo ou minimo) entre as regioes; sem nenhum preco vai para o fim.
 */
function precoOrdenacao(precos: TabelaPrecoCelula[]): number {
  const f = fob(precos);
  if (f != null) return f;
  let menor = Infinity;
  for (const c of precos) {
    if (
      c.estado === "vigente" &&
      c.valor != null &&
      (c.patamar === "CIF_ALVO" || c.patamar === "CIF_MINIMO") &&
      c.valor < menor
    ) {
      menor = c.valor;
    }
  }
  return menor;
}

/**
 * Familia/tipo do SKU: o codigo sem o ultimo segmento (o tamanho/dimensao).
 * Ex.: PRATO-ESP-ALV-30X40 -> PRATO-ESP-ALV. Codigos sem hifen (ex.: linha
 * Tecido, por metro) ficam inteiros. Serve para manter as variantes de um
 * mesmo tipo agrupadas em vez de intercala-las quando ordenadas por preco.
 */
function familiaSku(codigo: string): string {
  const i = codigo.lastIndexOf("-");
  return i > 0 ? codigo.slice(0, i) : codigo;
}

/**
 * Ordena os SKUs em dois niveis: agrupa por familia (mesmo tipo de tecido,
 * disco, etc.), ordena as familias pela mais barata e, dentro de cada uma,
 * por preco crescente. Onde nao ha intercalacao entre familias o resultado e
 * identico a uma ordenacao simples por preco — so a Tecelagem (varios tipos
 * por produto) muda de fato.
 */
function ordenarSkus(skus: TabelaPrecoSku[]): TabelaPrecoSku[] {
  const grupos = new Map<string, { min: number; itens: TabelaPrecoSku[] }>();
  for (const s of skus) {
    const fam = familiaSku(s.codigo_sku);
    const preco = precoOrdenacao(s.precos);
    const g = grupos.get(fam) ?? { min: Infinity, itens: [] };
    g.itens.push(s);
    if (preco < g.min) g.min = preco;
    grupos.set(fam, g);
  }
  const out: TabelaPrecoSku[] = [];
  for (const [, g] of [...grupos.entries()].sort((a, b) => a[1].min - b[1].min)) {
    g.itens.sort((a, b) => precoOrdenacao(a.precos) - precoOrdenacao(b.precos));
    out.push(...g.itens);
  }
  return out;
}

/**
 * cmp-tabela-precos-impressao — documento imprimivel da Tabela de Preços no
 * formato das planilhas de engenharia de custos da DLH: UMA tabela por Linha,
 * colunas SKU | FOB | LL% | <regioes>, cada celula de regiao mostrando o
 * intervalo "CIF Mínimo – CIF Alvo". FOB e valor unico (independe de regiao);
 * LL% e o lucro alvo do Produto. Le a selecao (linhas/regioes) da query, monta
 * o cabecalho/rodape institucional (config_empresa) + logo e dispara
 * window.print ao carregar. Estilo de papel (claro), alheio ao tema escuro.
 */
export function TabelaPrecosImpressao() {
  const params = useSearchParams();
  const linhaIds = useMemo(
    () => (params.get("linhas") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    [params],
  );
  const regioes = useMemo(
    () => lerLista<Regiao>(params.get("regioes"), REGIOES_ORDEM),
    [params],
  );
  // Ausencia do parametro `colunas` (links antigos) = mostrar FOB e LL%.
  const colunas = useMemo(() => {
    if (!params.has("colunas")) return new Set<Coluna>(COLUNAS_ORDEM);
    return new Set<Coluna>(lerLista<Coluna>(params.get("colunas"), COLUNAS_ORDEM));
  }, [params]);
  const mostrarFob = colunas.has("fob");
  const mostrarLl = colunas.has("ll");
  const quebraProdutoLinhas = useMemo(
    () =>
      new Set(
        (params.get("quebraProdutoLinhas") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    [params],
  );
  // Toggle global: mostrar a foto do produto na tabela.
  const mostrarImagens = params.get("imagens") === "1";

  const empresa = useConfigEmpresa();
  const linhas = useLinhas();
  const tabelas = useTabelasPrecos(linhaIds);

  const nomePorLinha = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of linhas.data?.items ?? []) map.set(l.id, l.nome);
    return map;
  }, [linhas.data]);

  const carregando =
    empresa.isLoading ||
    linhas.isLoading ||
    tabelas.some((t) => t.isLoading);
  const erro =
    empresa.isError || linhas.isError || tabelas.some((t) => t.isError);

  const printDisparado = useRef(false);
  useEffect(() => {
    if (carregando || erro || printDisparado.current) return;
    printDisparado.current = true;
    // Espera o layout/imagens assentarem antes de abrir o dialogo de impressao.
    const id = window.setTimeout(() => window.print(), 350);
    return () => window.clearTimeout(id);
  }, [carregando, erro]);

  if (linhaIds.length === 0 || regioes.length === 0) {
    return (
      <div style={{ padding: 40, color: "var(--err)" }}>
        Seleção inválida. Volte ao cockpit e gere a tabela novamente.
      </div>
    );
  }

  const e = empresa.data;
  const titulo = e?.nomeFantasia || e?.razaoSocial || "Tabela de preços";

  // Cabecalho repetido no topo de cada linha (= cada pagina na impressao).
  const cabecalho = (
    <div className="print-cabecalho">
      <header className="print-head">
        <div className="print-brand">
          {e?.logoBase64 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={e.logoBase64} alt="Logomarca" className="print-logo" />
          ) : (
            // Sem logo enviada: a estrelinha do cockpit como marca padrao do
            // documento (cores pinadas para papel via .print-brand .mini-logo).
            <span className="mini-logo" aria-hidden="true">
              <DlhLogo />
            </span>
          )}
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

      <div className="print-title">
        <div className="print-title-text">
          <h2>Tabela de preços</h2>
        </div>
        <div className="print-meta">
          <span className="print-meta-label">Emissão</span>
          <span className="print-meta-value">
            {formatDate(new Date().toISOString())}
          </span>
        </div>
      </div>

      <div className="print-legenda">
        Valores em R$. Cada célula de região mostra o intervalo{" "}
        <strong>CIF Mínimo – CIF Alvo</strong>.
        {mostrarFob ? " FOB é sem frete." : ""}
        {mostrarLl ? " LL% é o lucro alvo do produto." : ""}
      </div>
    </div>
  );

  const colSpan = 1 + (mostrarFob ? 1 : 0) + (mostrarLl ? 1 : 0) + regioes.length;
  const renderTabela = (lista: TabelaPrecoConsolidada["produtos"]) => (
    <table className="print-table">
      <thead>
        <tr>
          <th className="col-sku">SKU</th>
          {mostrarFob ? <th className="col-preco">FOB</th> : null}
          {mostrarLl ? <th className="col-ll">LL%</th> : null}
          {regioes.map((r) => (
            <th key={r} className="col-preco">
              {REGIAO_LABEL[r]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lista.map((produto) => (
          <FragmentProduto
            key={produto.produto_id}
            nome={produto.nome}
            lucroPct={produto.lucro_pct}
            fotoUrl={mostrarImagens ? produto.foto_url : null}
            colSpan={colSpan}
            skus={produto.skus}
            regioes={regioes}
            mostrarFob={mostrarFob}
            mostrarLl={mostrarLl}
          />
        ))}
      </tbody>
    </table>
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
        <div style={{ padding: 40, color: "var(--err)", display: "flex", gap: 8 }}>
          <TriangleAlert aria-hidden="true" />
          Não foi possível carregar os dados da tabela de preços.
        </div>
      ) : (
        <div className="print-page">
          {linhaIds.map((linhaId, i) => {
            const q = tabelas[i];
            const data = q?.data as TabelaPrecoConsolidada | undefined;
            const nome = nomePorLinha.get(linhaId) ?? "Linha";
            const produtos = (data?.produtos ?? []).filter((p) => p.skus.length > 0);

            if (produtos.length === 0) {
              return (
                <section key={linhaId} className="print-linha">
                  {cabecalho}
                  <h3 className="print-linha-nome">{nome}</h3>
                  <div className="print-vazio">Sem SKUs com preço vigente nesta linha.</div>
                </section>
              );
            }

            // Quebra por produto: cada produto vira sua propria pagina (= uma
            // .print-linha), herdando cabecalho e quebra de pagina.
            if (quebraProdutoLinhas.has(linhaId)) {
              return produtos.map((produto) => (
                <section key={`${linhaId}-${produto.produto_id}`} className="print-linha">
                  {cabecalho}
                  <h3 className="print-linha-nome">{nome}</h3>
                  {renderTabela([produto])}
                </section>
              ));
            }

            return (
              <section key={linhaId} className="print-linha">
                {cabecalho}
                <h3 className="print-linha-nome">{nome}</h3>
                {renderTabela(produtos)}
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

function FragmentProduto({
  nome,
  lucroPct,
  fotoUrl,
  colSpan,
  skus,
  regioes,
  mostrarFob,
  mostrarLl,
}: {
  nome: string;
  lucroPct: number | null;
  fotoUrl: string | null;
  colSpan: number;
  skus: TabelaPrecoConsolidada["produtos"][number]["skus"];
  regioes: Regiao[];
  mostrarFob: boolean;
  mostrarLl: boolean;
}) {
  return (
    <>
      <tr className="print-produto-row">
        <td colSpan={colSpan}>
          <div className="print-produto-cell">
            {fotoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fotoUrl} alt="" className="print-produto-foto" />
            ) : null}
            <span>{nome}</span>
          </div>
        </td>
      </tr>
      {ordenarSkus(skus).map((sku) => {
        const cells = indexar(sku.precos);
        return (
          <tr key={sku.sku_id}>
            <td className="col-sku mono">{sku.codigo_sku}</td>
            {mostrarFob ? (
              <td className="col-preco mono">{num(fob(sku.precos))}</td>
            ) : null}
            {mostrarLl ? <td className="col-ll mono">{pct(lucroPct)}</td> : null}
            {regioes.map((r) => {
              const min = valor(cells.get(`${r}-CIF_MINIMO`));
              const alvo = valor(cells.get(`${r}-CIF_ALVO`));
              return (
                <td key={r} className="col-preco mono">
                  {min == null && alvo == null ? (
                    <span className="cell-vazio">—</span>
                  ) : (
                    <span className="cell-faixa">
                      <span className="cell-min">{num(min)}</span>
                      <span className="cell-sep" aria-hidden="true">
                        –
                      </span>
                      <span className="cell-alvo">{num(alvo)}</span>
                    </span>
                  )}
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}
