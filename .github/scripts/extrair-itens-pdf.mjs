// =====================================================================
// .github/scripts/extrair-itens-pdf.mjs
// EXTRATOR DETERMINISTICO DE LISTA DE ITENS (PDF texto-nativo, por COORDENADA).
//
// Irmao do extrair-itens.mjs (docx). Roda no MESMO passo de extracao
// (extrair-anexos.mjs), so para vinculos fonte='effecti' e arquivo PDF que ja
// passou pela extracao de texto (ou seja: TEM camada de texto -- PDF imagem cai
// em precisa_ocr antes e nunca chega aqui). Le os itens de texto do pdfjs com
// suas COORDENADAS (transform[4]=x, transform[5]=y), reconstroi as linhas por
// cluster de y e classifica as celulas em colunas por BANDA. SEM LLM.
//
// RECALL: item errado e pior que item nenhum. Dois portoes conservadores:
//   1) confianca ESTRUTURAL: >=2 itens e maioria com und/qtd/preco;
//   2) recall ESTRITO: a numeracao tem que ser 1..N contigua, sem buraco nem
//      duplicata. Lista parcial OU multi-lote (numero reinicia) NAO passa -> []
//      e a LLM extrai sob demanda (o residuo fica na LLM).
//
// Saida no MESMO formato do extrair-itens.mjs (documento_itens): cada item com
// lista_origem / fonte_descricao / item_numero(string) / lote / descricao /
// unidade / quantidade / preco_referencia / ordem.
//
// PDF imagem (sem camada de texto -> pdfjs ve 0 coordenadas) devolve [] em
// silencio: a triagem segue pelo texto Tika/OCR e a Lia extrai sob demanda.
// =====================================================================

const Y_TOL = 3;
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Linhas de rodape/cabecalho institucional a ignorar dentro do corpo da tabela.
const RUIDO = /(prefeitura|secretaria municipal|pagina \d+ de|cep:?\s*\d|pra[cç]a |av\.|rua |cnpj|estado d)/;

const COLS = {
  item: /^(item|it\.?|seq|n[°º]?)$/,
  desc: /descri|especifica|objeto|produto/,
  und: /^(und\.?|unid\.?|unidade|u\.?m\.?)$/,
  qtd: /^(qtde?\.?|quant\.?|quantidade)$/,
  preco: /(valor|preco|preço|unit)/,
};
// Tabela de COMPOSICAO DE CUSTO (CA/IM/FL/CO/ML/PFV) NAO e lista de itens.
const FALSO = /(do custo|%\s*sobre|composic|formacao de preco|planilha de custo)/;

/** Agrupa os text-items de uma pagina em linhas (cluster por y), celulas ord. por x. */
function montarLinhas(items) {
  const L = [];
  for (const it of items) {
    const s = it.str;
    if (!s || !s.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    let l = L.find((z) => Math.abs(z.y - y) <= Y_TOL);
    if (!l) { l = { y, cels: [] }; L.push(l); }
    l.cels.push({ x, s: s.trim() });
  }
  for (const l of L) l.cels.sort((a, b) => a.x - b.x);
  L.sort((a, b) => b.y - a.y);
  return L.map((l) => ({
    y: l.y,
    cels: l.cels,
    texto: l.cels.map((c) => c.s).join(" ").replace(/\s+/g, " ").trim(),
  }));
}

/** Linha de cabecalho de tabela de itens -> mapa role->x do rotulo. null se nao reconhece. */
function detectarHeader(l) {
  const t = norm(l.texto);
  if (FALSO.test(t)) return null;
  const colX = {};
  for (const c of l.cels) {
    const cs = norm(c.s);
    for (const [nome, re] of Object.entries(COLS)) {
      if (re.test(cs) && colX[nome] === undefined) colX[nome] = c.x;
    }
  }
  const apoio = ["und", "qtd", "preco"].filter((k) => colX[k] !== undefined).length;
  return (colX.desc !== undefined && colX.item !== undefined && apoio >= 2) ? colX : null;
}

// Marcador de item: nearest entre TODAS as colunas (inclui 'item'); so p/ achar o numero.
const colMaisProxima = (x, colX) => {
  let melhor = null, dist = 1e9;
  for (const [nome, cx] of Object.entries(colX)) { const d = Math.abs(x - cx); if (d < dist) { dist = d; melhor = nome; } }
  return melhor;
};

// CORPO: fronteiras por banda EXCLUINDO 'item'. A descricao e left-aligned (comeca bem a
// esquerda do rotulo centralizado "DESCRICAO") -> absorve TUDO ate a fronteira desc|und. O
// numero do item NAO entra aqui (e identificado por conteudo e removido antes).
function fronteiras(colX) {
  const ordem = ["desc", "und", "qtd", "preco"].filter((r) => colX[r] !== undefined);
  const b = {};
  for (let i = 0; i < ordem.length; i++) {
    const r = ordem[i];
    const lo = i === 0 ? -Infinity : (colX[ordem[i - 1]] + colX[r]) / 2;
    const hi = i === ordem.length - 1 ? Infinity : (colX[r] + colX[ordem[i + 1]]) / 2;
    b[r] = [lo, hi];
  }
  return b;
}
const colPorBanda = (x, b) => {
  for (const [r, [lo, hi]] of Object.entries(b)) if (x >= lo && x < hi) return r;
  return null;
};

/** Numero pt-BR -> Number. "3.196,00"->3196, "7,99"->7.99. null se vazio. */
function parseNum(s) {
  const m = String(s ?? "").replace(/[^\d.,]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = parseFloat(m);
  return Number.isFinite(n) ? n : null;
}

/** Acumula em `itens` (numeros crus) os itens de uma pagina, a partir do header. */
function processarPagina(linhas, headerIdx, colX, itens) {
  const yHeader = linhas[headerIdx].y;
  const bandas = fronteiras(colX);
  // marcos = linhas-numero (celula na coluna ITEM = inteiro), abaixo do header, fora de ruido.
  const marcos = [];
  for (let i = headerIdx + 1; i < linhas.length; i++) {
    const l = linhas[i];
    const t = norm(l.texto);
    if (/total (do lote|da proposta|geral|item)|valor total/.test(t)) break;
    if (RUIDO.test(t)) continue;
    const celItem = l.cels.find((c) => colMaisProxima(c.x, colX) === "item" && /^\d{1,4}$/.test(c.s));
    if (celItem) marcos.push({ y: l.y, numero: parseInt(celItem.s, 10), markX: celItem.x });
  }
  if (!marcos.length) return;
  for (let k = 0; k < marcos.length; k++) {
    const yNum = marcos[k].y;
    const yCima = k === 0 ? yHeader : (marcos[k - 1].y + yNum) / 2;
    const yBaixo = k === marcos.length - 1 ? -Infinity : (yNum + marcos[k + 1].y) / 2;
    const descCels = []; let und = null, qtd = null; const precos = [];
    for (const l of linhas) {
      if (l.y >= yCima || l.y <= yBaixo) continue;
      if (RUIDO.test(norm(l.texto))) continue;
      for (const c of l.cels) {
        // exclui a celula do numero do item (cairia em desc pela banda) -- so na linha do marco.
        if (l.y === yNum && c.x === marcos[k].markX) continue;
        const col = colPorBanda(c.x, bandas);
        if (col === "desc") descCels.push({ y: l.y, s: c.s });
        else if (col === "und" && !und && /[a-zA-Zçãé]/.test(c.s) && !/^\d/.test(c.s)) und = c.s;
        else if (col === "qtd" && qtd == null) { const n = parseNum(c.s); if (n != null) qtd = n; }
        else if (col === "preco") { const n = parseNum(c.s); if (n != null) precos.push(n); }
      }
    }
    descCels.sort((a, b) => b.y - a.y);
    const descricao = descCels.map((c) => c.s).join(" ").replace(/\s+/g, " ").trim();
    if (descricao.replace(/[^a-zA-Zà-ú]/g, "").length < 6) continue;
    itens.push({
      item_numero: marcos[k].numero,
      descricao,
      unidade: und,
      quantidade: qtd,
      preco_referencia: precos.length ? (Math.min(...precos.filter((p) => p > 0)) || null) : null,
    });
  }
}

/** NUCLEO: recebe paginas (arrays de linhas) e devolve {motivo, itens(numeros crus)}. */
function extrairDePaginas(paginas, totalTextItems) {
  if (totalTextItems < 50) return { motivo: "sem_camada_texto", itens: [] };
  const itens = [];
  for (const linhas of paginas) {
    let colX = null, headerIdx = -1;
    for (let i = 0; i < linhas.length; i++) { const h = detectarHeader(linhas[i]); if (h) { colX = h; headerIdx = i; break; } }
    if (colX) processarPagina(linhas, headerIdx, colX, itens);
  }
  // GATE 1 -- confianca ESTRUTURAL: >=2 itens e maioria com und/qtd/preco preenchidos.
  const comDados = itens.filter((x) => x.unidade || x.quantidade != null || x.preco_referencia != null).length;
  if (itens.length < 2 || comDados < itens.length * 0.6) return { motivo: "tabela_nao_confiavel", itens: [] };
  // GATE 2 -- RECALL ESTRITO: numeracao 1..N contigua, sem buraco nem duplicata.
  const nums = itens.map((x) => x.item_numero);
  const contigua = nums.length > 0 && new Set(nums).size === nums.length
    && Math.min(...nums) === 1 && Math.max(...nums) === nums.length;
  if (!contigua) return { motivo: "numeracao_com_buracos", itens: [] };
  return { motivo: "ok", itens };
}

/** Mapeia os itens crus (numeros) para o formato canonico de documento_itens. */
function paraCanonico(itens) {
  return itens.map((it, i) => ({
    lista_origem: "tabela 1",
    fonte_descricao: "tecnica",
    item_numero: String(it.item_numero),
    lote: null,
    descricao: it.descricao,
    unidade: it.unidade,
    quantidade: it.quantidade,
    preco_referencia: it.preco_referencia,
    ordem: i,
  }));
}

/**
 * NUCLEO PURO testavel: recebe as paginas ja montadas (linhas) e devolve {motivo, itens}
 * com os itens crus (item_numero numerico). Usado pelos testes offline.
 */
export function extrairItensDePaginas(paginas, totalTextItems) {
  return extrairDePaginas(paginas, totalTextItems);
}

export { montarLinhas };

/**
 * Wrapper de PRODUCAO: desempacota o PDF (pdfjs, sob demanda) e devolve a lista de
 * itens no formato canonico (array, [] se nao reconhecer nada confiavel). pdfjs e
 * carregado sob demanda (so o runner do Actions precisa). Espelha extrairItensDocx.
 */
export async function extrairItensPdfBytes(bytes) {
  let getDocument;
  try {
    ({ getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs"));
  } catch {
    throw new Error("dependencia 'pdfjs-dist' ausente (npm i pdfjs-dist)");
  }
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  try {
    const paginas = [];
    let totalTextItems = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      totalTextItems += tc.items.length;
      paginas.push(montarLinhas(tc.items));
      page.cleanup();
    }
    const { itens } = extrairDePaginas(paginas, totalTextItems);
    return paraCanonico(itens);
  } finally {
    await doc.destroy();
  }
}
