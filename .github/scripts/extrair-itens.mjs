// =====================================================================
// .github/scripts/extrair-itens.mjs
// EXTRATOR DETERMINISTICO DE LISTA DE ITENS (docx), ESCOPO EFFECTI.
//
// Roda NO MESMO passo de extracao (extrair-anexos.mjs), so para vinculos
// fonte='effecti' e arquivo docx. Le a TABELA do word/document.xml celula a
// celula (a estrutura ainda existe, ao contrario do texto plano do Tika) e
// emite a(s) lista(s) de itens para documento_itens. SEM LLM.
//
// RECALL: item errado e pior que item nenhum (o gate de recall marcaria
// itens_status='extraido' e a triagem decidiria sobre lixo). Por isso o parser
// e CONSERVADOR: so emite uma tabela quando reconhece o cabecalho (coluna de
// descricao obrigatoria + ao menos uma coluna de apoio) e ha linhas de dados.
// Tabela ambigua -> NAO emite (fica pendente -> a Lia extrai sob demanda).
//
// MULTIPLAS LISTAS convivem: cada <w:tbl> reconhecida vira uma lista_origem
// distinta (corpo do edital + anexo TR etc.); NUNCA fundir.
//
// O nucleo (extrairItensDeDocumentXml) e PURO e nao depende de adm-zip, para
// ser testavel offline. O wrapper extrairItensDocx desempacota o docx (adm-zip,
// ja usado pelo extrator) e chama o nucleo.
// =====================================================================

// --- Sinonimos de cabecalho (pt-BR), normalizados (sem acento, minusculo). ---
const COL_ITEM = ["item", "itens", "no", "n", "numero", "seq", "sequencia", "cod", "codigo"];
const COL_LOTE = ["lote", "grupo"];
const COL_DESC = [
  "descricao", "produto", "produtoservico", "servico", "especificacao",
  "especificacoes", "objeto", "discriminacao", "material", "produtoservicos",
];
const COL_UNID = ["unid", "unidade", "und", "un", "umedida", "unidmedida", "unidademedida"];
const COL_QTD = ["qtd", "qtde", "quant", "quantidade", "qtdade"];
// Preco UNITARIO: exige marcador de "unit" para nao confundir com total.
const COL_PRECO_UNIT = [
  "valorunitario", "vlrunitario", "precounitario", "vunitario", "valorunit",
  "precounit", "unitario", "valorunitarioestimado", "valorunitr",
];
const COL_TOTAL = ["valortotal", "vlrtotal", "total", "precototal", "valortotalestimado"];

/** Normaliza um cabecalho de coluna: sem acento, minusculo, so alfanumerico. */
function normHeader(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Numero pt-BR -> Number. "3.196,00"->3196, "7,99"->7.99, "4"->4. null se vazio. */
function parseNumeroBr(s) {
  const raw = String(s ?? "").trim();
  if (raw === "") return null;
  // Mantem so digitos, pontos, virgulas e sinal.
  const limpo = raw.replace(/[^0-9.,-]/g, "");
  if (limpo === "" || limpo === "-") return null;
  // pt-BR: ponto = milhar, virgula = decimal. Remove pontos, troca virgula por ponto.
  const normalizado = limpo.replace(/\./g, "").replace(",", ".");
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

/**
 * Texto de um bloco XML: percorre o conteudo EM ORDEM concatenando os <w:t> e
 * inserindo um espaco nas fronteiras estruturais (fim de paragrafo </w:p>,
 * quebra de linha <w:br/>, tabulacao <w:tab/>). Runs do MESMO paragrafo ficam
 * grudados de proposito (o Word fatia uma palavra em varios <w:r> por formatacao
 * -> juntar sem espaco e o certo); so as quebras reais viram espaco, para uma
 * descricao multi-linha de TR nao colar "...gelcor azul". `\b` evita casar
 * <w:tabs> (tab stops do pPr). Decodifica entidades e colapsa espaco no fim.
 */
function textoDe(bloco) {
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<\/w:p>/g;
  let out = "";
  let m;
  while ((m = re.exec(String(bloco)))) {
    out += m[1] !== undefined ? m[1] : " ";
  }
  return out
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extrai blocos de uma tag (nao-aninhada no nivel que nos importa: tbl/tr/tc). */
function blocos(str, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[ >][\\s\\S]*?</${tag}>`, "g");
  let m;
  while ((m = re.exec(str))) out.push(m[0]);
  return out;
}

/** Linhas (arrays de strings de celula) de uma <w:tbl>. */
function linhasDaTabela(tblXml) {
  return blocos(tblXml, "w:tr").map((tr) => blocos(tr, "w:tc").map((tc) => textoDe(tc)));
}

/**
 * Tenta mapear uma linha de cabecalho -> indices de coluna. Retorna null se nao
 * reconhece o minimo (coluna de descricao + ao menos uma coluna de apoio
 * item/unidade/quantidade/preco). Conservador de proposito.
 */
function mapearColunas(celulas) {
  const idx = { item: -1, lote: -1, descricao: -1, unidade: -1, quantidade: -1, precoUnit: -1 };
  celulas.forEach((c, i) => {
    const h = normHeader(c);
    if (h === "") return;
    // Preco unitario antes de total/descricao (mais especifico).
    if (idx.precoUnit < 0 && COL_PRECO_UNIT.some((k) => h.includes(k))) { idx.precoUnit = i; return; }
    if (COL_TOTAL.some((k) => h === k || h.includes(k))) return; // total: ignorado de proposito
    if (idx.descricao < 0 && COL_DESC.some((k) => h.includes(k))) { idx.descricao = i; return; }
    if (idx.lote < 0 && COL_LOTE.some((k) => h === k)) { idx.lote = i; return; }
    if (idx.quantidade < 0 && COL_QTD.some((k) => h.includes(k))) { idx.quantidade = i; return; }
    if (idx.unidade < 0 && COL_UNID.some((k) => h === k || h.includes(k))) { idx.unidade = i; return; }
    if (idx.item < 0 && COL_ITEM.some((k) => h === k)) { idx.item = i; return; }
  });
  const temApoio = idx.item >= 0 || idx.unidade >= 0 || idx.quantidade >= 0 || idx.precoUnit >= 0;
  if (idx.descricao < 0 || !temApoio) return null;
  return idx;
}

/** Uma celula nao-vazia (depois de tirar espacos). */
function temConteudo(s) {
  return String(s ?? "").trim() !== "";
}

/**
 * Converte uma <w:tbl> em itens, se reconhecer o cabecalho. Retorna [] quando
 * a tabela nao parece uma lista de itens (sem header reconhecivel ou sem dados).
 */
function itensDaTabela(tblXml, listaOrigem) {
  const linhas = linhasDaTabela(tblXml);
  if (linhas.length < 2) return [];

  // Acha a primeira linha que mapeia como cabecalho; linhas acima = titulo (ignora).
  let headerRow = -1;
  let cols = null;
  for (let i = 0; i < Math.min(linhas.length, 5); i++) {
    const m = mapearColunas(linhas[i]);
    if (m) { headerRow = i; cols = m; break; }
  }
  if (!cols) return [];

  const itens = [];
  let ordem = 0;
  for (let r = headerRow + 1; r < linhas.length; r++) {
    const cel = linhas[r];
    const descricao = cols.descricao < cel.length ? String(cel[cols.descricao] ?? "").trim() : "";
    if (!temConteudo(descricao)) continue; // linha sem descricao = separador/rodape -> pula
    const item = {
      lista_origem: listaOrigem,
      fonte_descricao: "tecnica",
      item_numero: cols.item >= 0 && cols.item < cel.length ? (String(cel[cols.item] ?? "").trim() || null) : null,
      lote: cols.lote >= 0 && cols.lote < cel.length ? (String(cel[cols.lote] ?? "").trim() || null) : null,
      descricao,
      unidade: cols.unidade >= 0 && cols.unidade < cel.length ? (String(cel[cols.unidade] ?? "").trim() || null) : null,
      quantidade: cols.quantidade >= 0 && cols.quantidade < cel.length ? parseNumeroBr(cel[cols.quantidade]) : null,
      preco_referencia: cols.precoUnit >= 0 && cols.precoUnit < cel.length ? parseNumeroBr(cel[cols.precoUnit]) : null,
      ordem: ordem++,
    };
    itens.push(item);
  }
  return itens;
}

/**
 * NUCLEO PURO: recebe o conteudo de word/document.xml e devolve os itens de
 * TODAS as tabelas reconhecidas. Cada tabela vira uma lista_origem distinta
 * ("tabela N"); listas convivem, nunca fundidas. Retorna [] se nada reconhecido.
 */
export function extrairItensDeDocumentXml(xml) {
  const tabelas = blocos(String(xml ?? ""), "w:tbl");
  const itens = [];
  let listaIdx = 0;
  for (const tbl of tabelas) {
    const dessa = itensDaTabela(tbl, `tabela ${listaIdx + 1}`);
    if (dessa.length > 0) {
      itens.push(...dessa);
      listaIdx++;
    }
  }
  return itens;
}

/**
 * Wrapper: desempacota o docx (adm-zip) e roda o nucleo sobre word/document.xml.
 * adm-zip e carregado sob demanda (so o runner do Actions precisa). Retorna []
 * se nao for docx valido ou nao tiver document.xml.
 */
export async function extrairItensDocx(bytes) {
  let AdmZip;
  try {
    ({ default: AdmZip } = await import("adm-zip"));
  } catch {
    throw new Error("dependencia 'adm-zip' ausente (npm i adm-zip)");
  }
  const zip = new AdmZip(Buffer.from(bytes));
  const entry = zip.getEntry("word/document.xml");
  if (!entry) return [];
  const xml = entry.getData().toString("utf8");
  return extrairItensDeDocumentXml(xml);
}
