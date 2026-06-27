// Extrator DETERMINISTICO de listas de itens de licitacao (sem LLM).
//
// Ancora = aviso_itens_portal (item_numero + quantidade + unidade confiaveis do
// portal Effecti /all). Cada PARSER do REGISTRY sabe ler UM layout de tabela e
// contribui SO a DESCRICAO. O gate valida por sequencia/quantidade:
//   - casa item a item        -> descricao TECNICA do documento (rica)
//   - nao casa (comprimento ou
//     qtde com mesma unidade)  -> FALLBACK: descricao do PORTAL (generica)
//   - qtde difere mas UNIDADE
//     difere (caixa x unidade) -> divergencia de EMBALAGEM: vale a qtde+unidade
//                                 do EDITAL (verdade contratual), descricao tecnica
// item_numero e lote vem SEMPRE do portal. Recall total: a saida tem sempre
// ancora.length itens (nada some). O script GRAVA so o que um parser cobre e
// NUNCA toca os documentos irmaos (cada doc reflete a propria verdade; doc sem
// parser fica como esta, para o Extrator LLM cobrir o layout novo).
//
// Uso:
//   node scripts/extrair-itens-deterministico.mjs --aviso <effecti_id> --dry
//   node scripts/extrair-itens-deterministico.mjs --aviso <effecti_id>
//   node scripts/extrair-itens-deterministico.mjs --aviso <effecti_id> --doc <uuid>
//
// TREINO: rode com --dry e leia a cobertura. Um doc com layout desconhecido
// aparece como "SEM PARSER (layout novo)". Para cobri-lo, adicione uma entrada
// nova ao REGISTRY (detectar + parsear) e re-rode --dry ate validar.

import { readFileSync } from "node:fs";
import pg from "pg";

// --- argumentos -------------------------------------------------------------
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
function arg(nome) {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
}
const EFFECTI_ID = arg("--aviso");
const SO_DOC = arg("--doc");
if (!EFFECTI_ID) {
  console.error("Falta --aviso <effecti_id>. Ex: --aviso 7574584 --dry");
  process.exit(1);
}

// --- conexao (le SUPABASE_DB_URL do .env.local) -----------------------------
function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const linha of txt.split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// --- unidade-base (abreviacao do edital -> base canonica) -------------------
// O portal traz a unidade por extenso ("Caixa 24 UN"); pegamos a 1a palavra.
const UNID_BASE = {
  cx: "caixa", un: "unidade", und: "unidade", pct: "pacote", pc: "pacote",
  tubo: "tubo", rl: "rolo", rolo: "rolo", mt: "metro", m: "metro",
  resma: "resma", placa: "placa", pote: "pote", potes: "pote",
  bloco: "bloco", blocos: "bloco", fl: "folha", folha: "folha", bobina: "bobina",
  frasco: "frasco", bisnaga: "bisnaga", centena: "centena", cartela: "cartela",
  embalagem: "embalagem",
};
function normalizarUnidade(u) {
  const primeira = String(u ?? "").trim().toLowerCase().split(/[ \t]/)[0]
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return UNID_BASE[primeira] ?? primeira;
}

// ===========================================================================
// REGISTRY DE PARSERS  -- cada entrada cobre UM layout de tabela.
// Contrato:
//   id        : nome curto do layout
//   detectar  : (texto) => bool   (reconhece o layout no texto do doc)
//   parsear   : (texto) => [{ quantidade:Number, descricao:String, unidade?:String }]
//               em ORDEM de leitura (a reconciliacao e por sequencia vs ancora)
// Para treinar: adicione uma entrada nova aqui e re-rode --dry.
// ===========================================================================

// Layout A: "ITEM QTD UNID" no cabecalho, depois "N <unid> <qtd> <descricao>"
// (1 item pode vir invertido "N <qtd> <unid>"). Caso visto: DFD de escola (7574584).
const RX_A_BORDER = String.raw`(?:[A-Za-zçÇ]{1,7}[ \t]+\d{1,4}|\d{1,4}[ \t]+[A-Za-zçÇ]{1,7})`;
const RX_A_ITEM = new RegExp(
  String.raw`(?:^|\n)[ \t]*(\d{1,3})[ \t]+` +
    String.raw`(?:([A-Za-zçÇ]{1,7})[ \t]+(\d{1,4})|(\d{1,4})[ \t]+([A-Za-zçÇ]{1,7}))[ \t]+` +
    String.raw`([\s\S]*?)` +
    String.raw`(?=(?:\n[ \t]*\d{1,3}[ \t]+${RX_A_BORDER}[ \t])|$)`,
  "g",
);
const parserItemQtdUnid = {
  id: "tabela-item-qtd-unid",
  detectar: (texto) => texto.includes("ITEM QTD UNID"),
  parsear: (texto) => {
    // recorta do cabecalho ate a estimativa de valor e remove rodape repetido
    const ini = texto.indexOf("ITEM QTD UNID");
    const fimMarcas = ["ESTIMATIVA PRELIMINAR DO VALOR", "\n4. ", "\n4."];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 20);
      if (i >= 0 && i < fim) fim = i;
    }
    const corte = texto.slice(ini, fim)
      .replace(/ESCOLA ESTADUAL SETOR SUL[\s\S]*?financeirosetorsul2022@gmail\.com/g, " ");
    const itens = [];
    let ultimo = 0;
    let m;
    RX_A_ITEM.lastIndex = 0;
    while ((m = RX_A_ITEM.exec(corte)) !== null) {
      const numero = Number(m[1]);
      if (numero <= ultimo) continue; // numero dentro da descricao, ignora
      ultimo = numero;
      itens.push({
        unidade: (m[2] ?? m[5] ?? "").trim(),
        quantidade: Number(m[3] ?? m[4]),
        descricao: (m[6] ?? "").replace(/\s+/g, " ").trim(),
      });
    }
    return itens;
  },
};

// Layout B: linha de pedido/mapa "000/002 M 300,00 00018126 - DESCRICAO ..."
// (variante OCR "000 002 M 300,00 18126 - ..."). Caso visto: DFD Nomus (7769244).
const RX_B_ITEM = /^0*\d{1,3}[/ ]0*\d{1,3}\s+(\S+)\s+([\d.]+),\d{2}\s+\d+\s*[-–]\s*(.+)$/;
const RX_B_RUIDO = /^(Usu[aá]rio\/Matricula|SANTA BARBARA|SISTEMA DE COMPRAS|DOCUMENTO DE FORMALIZA|MAPA COMPARATIVO|Impress[aã]o|Hora:|P[aá]gina \d|Pre[cç]o M[eé]dio|Descri[cç][aã]o adicional|\d{7}\s)/i;
const parserPedidoLinha = {
  id: "dfd-pedido-linha",
  detectar: (texto) => texto.split(/\r?\n/).some((l) => RX_B_ITEM.test(l.trim())),
  parsear: (texto) => {
    const itens = [];
    let atual = null;
    for (const raw of texto.split(/\r?\n/)) {
      const linha = raw.trim();
      if (!linha) continue;
      const m = linha.match(RX_B_ITEM);
      if (m) {
        if (atual) itens.push(atual);
        const qtde = m[2].replace(/\./g, "").replace(/,.*/, "");
        atual = { quantidade: Number(qtde), unidade: m[1], descricao: m[3].trim(), extra: [] };
        continue;
      }
      if (atual && !RX_B_RUIDO.test(linha) && !/^\d+,\d{2}/.test(linha)) atual.extra.push(linha);
    }
    if (atual) itens.push(atual);
    return itens.map((it) => ({
      quantidade: it.quantidade,
      unidade: it.unidade,
      descricao: [it.descricao, ...it.extra].join(" ").replace(/\s+/g, " ").trim(),
    }));
  },
};

// Layout C: "ITEM DESCRIÇÃO LC 123/2006 QUANTIDADE UNIDADE VALOR UNITÁRIO VALOR TOTAL"
// Cada item: "<N> <desc multiline>\nEXCLUSIVO\nME/EPP\n<qtd> [<unidade>] R$ ..."
// O cabeçalho da tabela tem 2 linhas; os itens ficam entre o VALOR TOTAL do
// cabeçalho e o VALOR TOTAL final (rodapé de fechamento da tabela).
// Rodapé de página repetido intercalado: bloco "mailto:...PREFEITURA...E-mail:..."
// Caso visto: TR de pregão eletrônico Prefeitura de Bom Princípio do PI (7490750).
const RX_C_RODAPE = /mailto:[^\n]+\n[\s\S]*?E-mail:[^\n]+\n[ \t]*\n/g;
// captura: (num)(corpo até qtd)(qtd)(unidade opcional) R$
const RX_C_ITEM = /^(\d{1,3})[ \t]*([\s\S]*?)(\d[\d.]*)[ \t]+(?:([A-Za-zÀ-ÿçÇ]{2,15})[ \t]+)?R\$/gm;
const parserTRBomPrincipio = {
  id: "tr-item-desc-lc-qtd-unid",
  detectar: (texto) =>
    texto.includes("ITEM DESCRIÇÃO LC 123/2006 QUANTIDADE UNIDADE"),
  parsear: (texto) => {
    // o cabeçalho é: "ITEM DESCRIÇÃO LC 123/2006 QUANTIDADE UNIDADE\n VALOR\nUNITÁRIO\nVALOR TOTAL"
    // itens ficam entre o 1o VALOR TOTAL (do cabeçalho) e o 2o VALOR TOTAL (rodapé da tabela)
    const posCab = texto.indexOf("ITEM DESCRIÇÃO LC 123/2006 QUANTIDADE UNIDADE");
    const posVT1 = texto.indexOf("VALOR TOTAL", posCab);
    const ini = posVT1 + "VALOR TOTAL".length;
    const fimMarca = texto.indexOf("VALOR TOTAL", ini + 10);
    const corte = texto
      .slice(ini, fimMarca > ini ? fimMarca : texto.length)
      // remove rodapé de página repetido (bloco mailto + header prefeitura)
      .replace(RX_C_RODAPE, "\n")
      // remove ruído "EXCLUSIVO [ME/EPP]" (isolado ou na mesma linha)
      .replace(/EXCLUSIVO\s*(?:\n\s*)?(?:ME\/EPP)?/g, "")
      .replace(/^ME\/EPP[ \t]*/gm, "")
      .replace(/\n{3,}/g, "\n\n");

    // regex captura cada item: número no início de linha + corpo + qtd + [unid] + R$
    const itens = [];
    let ultimoNum = 0;
    let m;
    RX_C_ITEM.lastIndex = 0;
    while ((m = RX_C_ITEM.exec(corte)) !== null) {
      const num = Number(m[1]);
      if (num <= ultimoNum || num > 999) continue; // ignora matches dentro de corpo
      ultimoNum = num;
      const quantidade = Number(m[3].replace(/\./g, ""));
      const unidade = (m[4] ?? "").trim() || undefined;
      const descricao = m[2].replace(/\s+/g, " ").trim();
      if (!descricao || !quantidade) continue;
      itens.push({ quantidade, descricao, ...(unidade ? { unidade } : {}) });
    }
    return itens;
  },
};

// Layout D: "Item Descrição Unid. Quant." — tabela do TR de pregão eletrônico
// formato LicitaFácil. Cada item: "<N> <desc multiline>\n\n<Unidade> <qtd>,0000\n"
// A unidade pode colar no fim da última linha de descrição (OCR de coluna PDF).
// Rodapé de página repetido entre itens: "N/25\n\n1243 - TERMO DE REFERÊNCIA...\n\n\nItem Descrição Unid. Quant."
// Fim da tabela marcado por "5 - PRAZO DE VIGÊNCIA" (ou "5 - PRAZO DE VIG").
// Caso visto: TR Lima Duarte-MG (7498645).
const RX_D_RODAPE = /\d{1,3}\/\d{1,3}\s*\n[\s\S]*?1243[^\n]*\n[\s\S]*?Item Descri[\s\S]*?Quant\.\s*\n/g;
// linha de fechamento: "<Unidade> <qtd>,<decimais>" — unidade = palavra(s) sem dígito
const RX_D_FECHAMENTO = /^(.+?)\s+([\d.]+),\d{4}\s*$/;
const parserLimaduarteTR = {
  id: "tr-item-desc-unid-qtd-lf",
  detectar: (texto) =>
    texto.includes("Item Descrição Unid. Quant.") &&
    texto.includes("1243 - TERMO DE REFERÊNCIA"),
  parsear: (texto) => {
    // recorta tabela: do 1o cabeçalho até a seção 5
    const ini = texto.indexOf("Item Descrição Unid. Quant.");
    const fimMarcas = ["5 - PRAZO DE VIG", "5 - ESTIMATIVA", "\n6 "];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 20);
      if (i >= 0 && i < fim) fim = i;
    }
    const corte = texto
      .slice(ini, fim)
      // remove rodapés de página + cabeçalho repetido
      .replace(RX_D_RODAPE, "\n")
      // remove cabeçalho restante no início
      .replace(/^Item Descri[^\n]*\n/, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const itens = [];
    // split por início de item: linha começando com número seguido de espaço e letra
    const blocos = corte.split(/(?=^\d{1,3} +[^\d\n])/m);
    for (const bloco of blocos) {
      const linhas = bloco.replace(/\r/g, "").split("\n");
      // primeira linha: "<N> <início da descrição>"
      const mNum = linhas[0].match(/^(\d{1,3}) +([\s\S]*)/);
      if (!mNum) continue;
      const num = Number(mNum[1]);
      if (num < 1 || num > 999) continue;

      // coleta todas as linhas não-vazias do bloco
      const corpo = linhas
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      // a última linha deve ser "<Unidade> <qtd>,0000"
      const ultima = corpo[corpo.length - 1];
      const mFech = ultima ? ultima.match(RX_D_FECHAMENTO) : null;
      if (!mFech) continue; // bloco sem fechamento legível

      const unidade = mFech[1].trim();
      const quantidade = Number(mFech[2].replace(/\./g, ""));

      // descrição = tudo exceto o número inicial e a linha de fechamento
      const descLinhas = corpo.slice(0, corpo.length - 1);
      // remove o número do início da 1a linha
      descLinhas[0] = descLinhas[0].replace(/^\d{1,3} +/, "");
      const descricao = descLinhas.join(" ").replace(/\s+/g, " ").trim();

      if (!descricao || !quantidade) continue;
      itens.push({ quantidade, unidade, descricao });
    }
    return itens;
  },
};

// Layout E: ETP com cabecalho "ITEM CATMAT DESCRICAO UNID. QUANT. VALOR UNITARIO ESTIMADO"
// Cada item: "<N> [<catmat>] <desc multiline>\n\n<Und.|Unid.> <qtd> R$"
// CATMAT (5-6 digitos) e opcional (item sem CATMAT comeca direto na descricao).
// Caso visto: ETP Camara Municipal Curvelo (7509020).
const parserETPCatmatUnidQtd = {
  id: "etp-catmat-unid-qtd",
  detectar: (texto) => texto.includes("ITEM CATMAT DESCRIÇÃO UNID. QUANT."),
  parsear: (texto) => {
    const ini = texto.indexOf("ITEM CATMAT DESCRIÇÃO UNID. QUANT.");
    const fimMarca = "O valor apresentado possui caráter meramente estimativo";
    const fim = texto.indexOf(fimMarca, ini);
    const corpo = texto.slice(ini, fim > ini ? fim : texto.length);

    // split por inicio de item: linha comecando com 2 digitos + espaco
    const blocos = corpo.split(/\n(?=\d{2} )/);
    const itens = [];
    for (const bloco of blocos) {
      const blocoTxt = bloco.replace(/\r/g, "").trimStart();
      if (!/^\d{2} /.test(blocoTxt)) continue;

      // Remove numero do item (e CATMAT opcional: 5-6 digitos)
      const semNum = blocoTxt.replace(/^\d{2}\s+(?:\d{5,6}\s+)?/, "");

      // Extrair quantidade: primeiro (e geralmente unico) Und./Unid. + num + R$
      // O Tika pode intercalar a coluna UNID/QUANT/VALOR no MEIO da descricao
      // (column interleaving do PDF). Extrair a qtd do match e DEPOIS limpar o texto.
      const mUnidFirst = semNum.match(/(Und\.|Unid\.)\s+(\d+)\s*R\$/);
      if (!mUnidFirst) continue;
      const quantidade = Number(mUnidFirst[2]);

      // Descricao: remove TODOS os artefatos de interleaving (Und. N R$ preco) e
      // precos soltos -- o que sobra e a descricao tecnica completa.
      const descricao = semNum
        .replace(/(Und\.|Unid\.)\s+\d+\s*R\$\s*[\d.,]+\s*(?:R\$\s*[\d.,]+)?/gi, " ")
        .replace(/\bR\$\s*[\d.,]+\b/g, " ")
        .replace(/\s+/g, " ").trim();

      if (!descricao || !quantidade) continue;
      itens.push({ quantidade, unidade: "UND", descricao });
    }
    return itens;
  },
};

// Layout F: "Item Nome Unid. Quant. V. Est. Unit. V. Est. Total Class."
// Tabela de precos estimados de pregao eletronico. Dois sub-padroes de item:
//   PADRAO A (multiline): numero sozinho na linha, descricao multiline, unid+qtd em linha propria
//     <N>\n<desc multiline>\n<UNID> <QTD>\nR$...\n<CLASSIFICACAO>
//   PADRAO B (inline): descricao curta, tudo numa unica linha (o Tika nao quebra a coluna)
//     <N> <desc> <UNID> <QTD> R$ ... R$ ... <CLASSIFICACAO>
//     Continuacao pode vazar pra linhas seguintes (ex: rodape corta a linha)
// Rodape de pagina intercalado: "Edital Pregão Eletrônico nº ...ADM..."
// Fim da tabela marcado por "Valor Global:" ou secao "1.4".
// Caso visto: PE 010/2026 Dianopolis-TO (7509738), 575 itens.
const RX_F_RODAPE = /\s*Edital Pregão Eletrônico nº[^\n]*\n[\s\S]*?ADM\.\s*\d{4}\/?\s*\d{0,4}\.\s*\n/g;
const parserPEItemNomeUnidQtd = {
  id: "pe-item-nome-unid-qtd",
  detectar: (texto) =>
    texto.includes("Item Nome Unid.") &&
    texto.includes("V. Est. Unit.") &&
    texto.includes("V. Est. Total"),
  parsear: (texto) => {
    // recortar da tabela ate Valor Global
    const cabecalho = "Item Nome Unid.";
    const ini = texto.indexOf(cabecalho);
    if (ini < 0) return [];
    const fimMarcas = ["Valor Global:", "1.4 O objeto desta contratação"];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 20);
      if (i >= 0 && i < fim) fim = i;
    }
    const corte = texto
      .slice(ini, fim)
      // remover rodape de pagina repetido
      .replace(RX_F_RODAPE, "\n")
      // remover linhas em branco multiplas
      .replace(/\n{3,}/g, "\n\n");

    const itens = [];
    // PASSO 1: split por numero sozinho na linha (padrao A — maioria dos itens)
    const blocos = corte.split(/\n(?=\d{1,3}\s*\n)/);
    const numerosCapturados = new Set();
    for (const bloco of blocos) {
      const linhas = bloco.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      if (!linhas.length) continue;
      const mNum = linhas[0].match(/^(\d{1,3})$/);
      if (!mNum) continue;
      const num = Number(mNum[1]);

      // Encontrar a linha com UNID + QTD: pode estar em linha propria ("UN 20")
      // OU no final da linha de descricao ("AFASTADOR DE MINESSOTA UN 20")
      let unidQtdIdx = -1;
      let unidade = "";
      let quantidade = 0;
      let descSuffix = ""; // parte da descricao antes da unid+qtd embutida
      for (let i = 1; i < linhas.length; i++) {
        // Caso 1: linha INTEIRA e unid+qtd
        const m = linhas[i].match(/^([A-Za-zÀ-ÿçÇ]{1,5})\s+([\d.]+)\s*$/);
        if (m) {
          unidade = m[1].toUpperCase();
          quantidade = Number(m[2].replace(/\./g, ""));
          unidQtdIdx = i;
          break;
        }
        // Caso 2: unid+qtd embutida no FINAL da linha (descricao curta)
        // Detectar: a proxima linha e "R$" ou vazia seguida de "R$" (confirma fim da descricao)
        const mEmbutida = linhas[i].match(/^(.+?)\s+([A-Za-zÀ-ÿçÇ]{1,5})\s+([\d.]+)\s*$/);
        if (mEmbutida) {
          // Confirmar: proxima linha nao-vazia deve ser "R$" (preco) ou "EXCLUSIVO" ou "COTA"
          const proxNaoVazia = linhas.slice(i + 1).find((l) => l.length > 0);
          if (proxNaoVazia && /^(?:R\$|EXCLUSIVO|COTA)/.test(proxNaoVazia)) {
            descSuffix = mEmbutida[1];
            unidade = mEmbutida[2].toUpperCase();
            quantidade = Number(mEmbutida[3].replace(/\./g, ""));
            unidQtdIdx = i; // descricao vai ate ANTES desta linha (sera substituida por descSuffix)
            break;
          }
        }
      }
      if (unidQtdIdx < 0) continue;
      let descricao;
      if (descSuffix) {
        // Caso 2: a descricao e descSuffix (ja extraida da mesma linha da unid+qtd)
        // + linhas anteriores se houver (raro neste padrao, mas por seguranca)
        const descLinhas = linhas.slice(1, unidQtdIdx);
        descricao = [...descLinhas, descSuffix]
          .filter((l) => !/^R\$\s/.test(l) && !/^EXCLUSIVO/.test(l) && !/^ME\/EPP/.test(l) && !/^COTA/.test(l))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      } else {
        // Caso 1: unid+qtd em linha propria
        const descLinhas = linhas.slice(1, unidQtdIdx);
        descricao = descLinhas
          .filter((l) => !/^R\$\s/.test(l) && !/^EXCLUSIVO/.test(l) && !/^ME\/EPP/.test(l) && !/^COTA/.test(l))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }

      if (!descricao || !quantidade) continue;
      numerosCapturados.add(num);
      itens.push({ _num: num, quantidade, unidade, descricao });
    }

    // PASSO 2: varrer linhas inline (padrao B — itens com descricao curta na mesma linha)
    // Formato: "<N> <desc> <UNID> <QTD> R$ ..." tudo numa linha, possivelmente com
    // continuacao na proxima (ex: rodape corta e vaza "PORTATIL" ou "x 4,5 metros o rolo.")
    const todasLinhas = corte.split("\n");
    for (let i = 0; i < todasLinhas.length; i++) {
      const linha = todasLinhas[i].trim();
      if (!linha) continue;
      // Tentar match: "<N> <texto> <UNID> <QTD> R$ ..."
      const mInline = linha.match(
        /^(\d{1,3})\s+(.+?)\s+([A-Za-zÀ-ÿçÇ]{1,5})\s+([\d.]+)\s+R\$/,
      );
      if (!mInline) continue;
      const num = Number(mInline[1]);
      if (num < 1 || num > 999) continue;
      if (numerosCapturados.has(num)) continue; // ja capturado pelo passo A

      const unidade = mInline[3].toUpperCase();
      const quantidade = Number(mInline[4].replace(/\./g, ""));
      let descricao = mInline[2].trim();
      // Coletar linhas de continuacao (descricao que vazou pra proxima linha por rodape)
      // Continua enquanto a proxima linha nao e R$, EXCLUSIVO, ME/EPP, COTA, numero de item
      for (let j = i + 1; j < todasLinhas.length; j++) {
        const prox = todasLinhas[j].trim();
        if (!prox) break;
        if (/^R\$/.test(prox) || /^\d+,\d{2}$/.test(prox) ||
            /^EXCLUSIVO/.test(prox) || /^ME\/EPP/.test(prox) ||
            /^COTA/.test(prox) || /^RESERVADA/.test(prox) ||
            /^PRINCIPAL/.test(prox) || /^AMPLA/.test(prox) ||
            /^\d{1,3}\s*$/.test(prox) || /^\d{1,3} +[A-ZÀ-ÿa-z]/.test(prox)) break;
        descricao += " " + prox;
      }
      descricao = descricao.replace(/\s+/g, " ").trim();

      if (!descricao || !quantidade) continue;
      numerosCapturados.add(num);
      itens.push({ _num: num, quantidade, unidade, descricao });
    }

    // Ordenar por numero do item (os inline do passo B ficam fora de ordem no array)
    itens.sort((a, b) => a._num - b._num);
    // Remover propriedade auxiliar
    return itens.map(({ _num, ...rest }) => rest);
  },
};

// Layout G: "COD DISCRIMINAÇÃO [ UND QUANTIDADE"
// Tabela de Termo de Referência com cabecalho "COD DISCRIMINAÇÃO" + coluna "UND QUANTIDADE".
// Cada item: "<N> <desc multilinhas>\n\n<unidade> <qtd>\n"
// A unidade e uma palavra ("unidades", "pacotes", "Pares", "fardos", "pacote") seguida da qtd.
// Rodape de pagina intercalado: blocos "Av. Alyson..." / "ESTADO DA PARAÍBA" / "PREFEITURA..."
// com OCR ruidoso entre eles.
// Fim da tabela marcado por "1.4.O objeto" ou "1.4. O objeto" (paragrafo apos a tabela).
// Caso visto: TR Barauna-PB (7513650), 61 itens.
// O [\s\S]{0,600}? limita a 600 chars (rodape real ~300 chars; evita engolir paginas
// inteiras quando OCR corrompe o CNPJ, ex: "0001-n" em vez de "0001-71").
// [\w.\/\- ] aceita alfanumericos (OCR pode trocar digito por letra).
const RX_G_RODAPE = /Av\.\s*A[lI]yson[\s\S]{0,600}?(?:CNPJ|CN ?PJ|C ?N ?PJ)\s*:?\s*[\w.\/\- ]+\s*\n/g;
// Ruido OCR entre rodapes (linhas curtas com lixo de OCR tipo "Barai1", "Pre`eitura", etc.)
const RX_G_LIXO_OCR = /(?:Pre[`']?e[fi](?:tu|[ti])ra\s+Mu[nñ]i[ck](?:ip|[i1]p)a[il]\s+[do]e[/\s]|[Bb]arai[1i]|[Bb]arau[nñ]a\b|Desen[vw]o[lI]v[ei]ment[o0ó]\s+c[o0]m\s+hu[mr][aá]ni[sz][ae][çc][aã]o|C\s*N\s*P\s*J|\.~►|~\s*\.|unto\s+corn|ESTADO\s+DA\s+PARAI|\d{2}\.\d{3}\.\d{3}\/\d{4})/i;
// Unidades validas do layout (lowercase)
const UNID_G_VALIDAS = new Set(["unidades", "unidade", "pacotes", "pacote", "pares", "par", "fardos", "fardo"]);
const parserCodDiscriminacao = {
  id: "tr-cod-discriminacao-und-qtd",
  detectar: (texto) =>
    /COD\s+DISCRIMINA[CÇ][ÃA]O/.test(texto) &&
    /UND\s+QUANTIDADE/.test(texto),
  parsear: (texto) => {
    // Recortar da tabela (cabecalho COD) ate secao 1.4
    const cabMatch = texto.match(/COD\s+DISCRIMINA[CÇ][ÃA]O/);
    if (!cabMatch) return [];
    const ini = cabMatch.index;
    const fimMarcas = ["1.4.O objeto", "1.4. O objeto", "1.4.O Objeto", "\n2.0. ", "\n2.0 "];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 20);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(ini, fim);
    // Remover rodapes de pagina intercalados
    corte = corte.replace(RX_G_RODAPE, "\n");
    // Remover linhas de lixo OCR (linhas curtas que nao sao descricao de item)
    corte = corte.split("\n").filter((l) => !RX_G_LIXO_OCR.test(l)).join("\n");
    // Remover linhas em branco multiplas
    corte = corte.replace(/\n{3,}/g, "\n\n");

    const itens = [];
    // Split por inicio de item: linha comecando com numero (1-3 digitos) seguido de espaco e letra maiuscula
    const blocos = corte.split(/\n(?=\d{1,3}\s+[A-ZÁÀÃÉÊÍÓÔÚÇ])/);
    for (const bloco of blocos) {
      const raw = bloco.trim();
      if (!raw) continue;
      const mNum = raw.match(/^(\d{1,3})\s+([\s\S]*)/);
      if (!mNum) continue;
      const num = Number(mNum[1]);
      if (num < 1 || num > 999) continue;

      const corpo = mNum[2];
      // Encontrar a linha de unidade+quantidade: "<unidade> <qtd>" no final do bloco
      // A unidade e uma das palavras validas (case-insensitive)
      const linhas = corpo.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

      let unidade = null;
      let quantidade = null;
      let unidLinha = -1;

      // Procurar de tras pra frente a linha "<unidade> <qtd>"
      for (let i = linhas.length - 1; i >= 0; i--) {
        const m = linhas[i].match(/^(\S+)\s+(\d+)\s*$/);
        if (m && UNID_G_VALIDAS.has(m[1].toLowerCase())) {
          unidade = m[1];
          quantidade = Number(m[2]);
          unidLinha = i;
          break;
        }
        // Tambem tentar no final da linha de descricao: "...TEXTO unidades 120"
        const mFim = linhas[i].match(/^(.*?)\s+(unidades|unidade|pacotes|pacote|pares|par|fardos|fardo)\s+(\d+)\s*$/i);
        if (mFim) {
          unidade = mFim[2];
          quantidade = Number(mFim[3]);
          // substituir a linha pela parte antes da unidade (continuacao de descricao)
          linhas[i] = mFim[1].trim();
          unidLinha = i + 1; // descricao vai ate esta linha (inclusive)
          break;
        }
      }
      if (quantidade == null) continue; // sem unidade/qtd legivel

      // Descricao: tudo antes da linha de unidade
      const descLinhas = linhas.slice(0, unidLinha);
      const descricao = descLinhas.join(" ").replace(/\s+/g, " ").trim();
      if (!descricao) continue;

      itens.push({ quantidade, descricao, ...(unidade ? { unidade } : {}) });
    }
    return itens;
  },
};

// Layout H: "ITEM ESPECIFICAÇÃO TÉCNICA DOS EQUIPAMENTOS/MATERIAIS UNID.  QTD"
// Tabela de TR de pregão SRP com cabecalho repetido por página.
// Formato NORMAL (maioria dos itens):
//   <numero sozinho na linha>
//   <descricao multilinhas>
//   <UNIDADE> <QTD>           -- ex: UND 06, Conjunto 10, Jogo 25, KIT 30
// Formato INLINE (itens curtos, tudo numa linha):
//   <numero> <descricao curta> <UNIDADE> <QTD>
//   ex: "15 CAIXA DE SOM ATIVA BI-AM UND 06"
//   ex: "68 OTOSCÓPIO UND 15"
// Caso especial: UND e QTD em linhas separadas (coluna Tika vazou):
//   UND\n\n15\n   -- a quantidade veio separada da unidade por linha vazia
// Rodape de pagina intercalado: blocos de espaços + "cpl.pmtg@gmail.com" + cabecalho repetido.
// A descricao pode ser CORTADA pelo rodape e continuar apos ele (ex: item 31, 53).
// Unidades possiveis: UND, Conjunto, Jogo, KIT (case-insensitive).
// Fim da tabela marcado por "1.3 –" ou "1.3 –" (JUSTIFICATIVA).
// Caso visto: TR Taboleiro Grande-RN (7525332), 80 itens.
const RX_H_UNIDADES = /^(UND|Und|und|Conjunto|conjunto|Jogo|jogo|KIT|Kit|kit)$/i;
const RX_H_UNID_QTD = /^(UND|Und|und|Conjunto|conjunto|Jogo|jogo|KIT|Kit|kit)\s+(\d+)\s*$/;
const RX_H_INLINE = /^(\d{1,3})\s+(.+?)\s+(UND|Und|und|Conjunto|conjunto|Jogo|jogo|KIT|Kit|kit)\s+(\d+)\s*$/;
const parserTREspecTecnica = {
  id: "tr-item-espec-tecnica-unid-qtd",
  detectar: (texto) =>
    /ITEM\s+ESPECIFICA[ÇC][ÃA]O\s+T[ÉE]CNICA\s+DOS\s+EQUIPAMENTOS\/MATERIAIS\s+UNID\.?\s+QTD/i.test(texto),
  parsear: (texto) => {
    // 1. Recortar do primeiro cabecalho ate "1.3 –"
    const cabRx = /ITEM\s+ESPECIFICA[ÇC][ÃA]O\s+T[ÉE]CNICA\s+DOS\s+EQUIPAMENTOS\/MATERIAIS\s+UNID\.?\s+QTD/gi;
    let m;
    let firstPos = -1;
    while ((m = cabRx.exec(texto)) !== null) {
      if (firstPos < 0) firstPos = m.index;
    }
    if (firstPos < 0) return [];
    const fimMarcas = ["1.3 –", "1.3 \u2013", "1.3 -"];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, firstPos + 50);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(firstPos, fim);

    // 2. Remover rodapes de pagina + cabecalhos repetidos
    // Estrategia: remover LINHA A LINHA para nao engolir conteudo util
    // (descricao pode continuar APOS rodape, ex: item 31, 53, 75)
    corte = corte.split("\n").filter((l) => {
      const t = l.trim();
      // Remover linhas do email
      if (/^cpl\.pmtg@gmail\.com$/i.test(t)) return false;
      // Remover linhas que sao so espacos (rodape de pagina PDF)
      if (t.length === 0) return true; // manter linhas vazias (separador de bloco)
      if (/^\s+$/.test(l) && t.length === 0) return false;
      return true;
    }).join("\n");
    // Remover cabecalhos repetidos da tabela
    corte = corte.replace(
      /ITEM\s+ESPECIFICA[ÇC][ÃA]O\s+T[ÉE]CNICA\s+DOS\s+EQUIPAMENTOS\/MATERIAIS\s+UNID\.?\s+QTD\s*/gi,
      "\n"
    );
    // Juntar linhas hifenizadas pelo Tika (ex: "Con-\njunto" -> "Conjunto")
    corte = corte.replace(/(\w)-\s*\n\s*(\w)/g, "$1$2");
    // Colapsar linhas vazias
    corte = corte.replace(/\n{3,}/g, "\n\n").trim();

    // 3. Parse: reconhecer blocos de itens
    const lines = corte.split("\n");
    const itens = [];
    let i = 0;
    let ultimoNumProcessado = 0; // para evitar confundir numeros da descricao com itens

    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l) { i++; continue; }

      // Caso A: item INLINE (numero + desc + unid + qtd tudo na mesma linha)
      const mInline = l.match(RX_H_INLINE);
      if (mInline && Number(mInline[1]) > ultimoNumProcessado) {
        ultimoNumProcessado = Number(mInline[1]);
        itens.push({
          quantidade: Number(mInline[4]),
          unidade: mInline[3],
          descricao: mInline[2].replace(/\s+/g, " ").trim(),
        });
        i++;
        continue;
      }

      // Caso B: numero sozinho na linha (padrao normal) ou "numero desc-inicio"
      const mNum = l.match(/^(\d{1,3})\s*$/);
      const mNumDesc = !mNum ? l.match(/^(\d{1,3})\s+([A-ZÁÀÃÉÊÍÓÔÚÇ].*)/) : null;
      const num = mNum ? Number(mNum[1]) : mNumDesc ? Number(mNumDesc[1]) : null;
      // So aceitar como item se for MAIOR que o ultimo processado (evita confundir
      // numeros da descricao como "04" em "saidas simultaneas 04" com item 4)
      if (num == null || num < 1 || num > 80 || num <= ultimoNumProcessado) { i++; continue; }

      // Coletar linhas de descricao ate encontrar UNID+QTD
      const descLines = [];
      if (mNumDesc) descLines.push(mNumDesc[2].trim());
      let j = i + 1;
      let unidade = null;
      let quantidade = null;

      while (j < lines.length) {
        const cl = lines[j].trim();

        // Linha vazia: pular
        if (!cl) { j++; continue; }

        // UNID+QTD na mesma linha (caso mais comum)
        const mUQ = cl.match(RX_H_UNID_QTD);
        if (mUQ) {
          unidade = mUQ[1];
          quantidade = Number(mUQ[2]);
          j++;
          break;
        }

        // UNID sozinha na linha (caso Tika separou as colunas)
        // ex: "UND\n\n15\n" onde 15 e a quantidade e NAO um item
        if (RX_H_UNIDADES.test(cl)) {
          unidade = cl;
          // Procurar a quantidade nas proximas linhas (pulando vazias)
          let k = j + 1;
          while (k < lines.length) {
            const kl = lines[k].trim();
            if (!kl) { k++; continue; }
            // Se e um numero puro, e a quantidade
            if (/^\d{1,4}$/.test(kl)) {
              quantidade = Number(kl);
              j = k + 1;
              break;
            }
            // Senao, nao achamos a quantidade (aborta)
            break;
          }
          if (quantidade != null) break;
          // Se nao achou quantidade, trata "UND" como parte da descricao (improvavel)
          unidade = null;
          descLines.push(cl);
          j++;
          continue;
        }

        // Verificar se a linha atual e o proximo item (inline ou numero sozinho)
        // So considerar como item se for MAIOR que o atual (evita "04" na descricao)
        const mProxNum = cl.match(/^(\d{1,3})\s*$/);
        if (mProxNum && Number(mProxNum[1]) > num) break;
        const mProxInline = cl.match(RX_H_INLINE);
        if (mProxInline && Number(mProxInline[1]) > num) break;

        // Linha de descricao normal
        descLines.push(cl);
        j++;
      }

      if (quantidade != null) {
        const descricao = descLines.join(" ").replace(/\s+/g, " ").trim();
        if (descricao) {
          ultimoNumProcessado = num;
          itens.push({ quantidade, descricao, ...(unidade ? { unidade } : {}) });
        }
      }

      i = j;
    }

    return itens;
  },
};

// Layout I: "ITEM IPM CATMAT DESCRIÇÃO UND. QTDE UNITÁRIO TOTAL"
// Tabela do Quadro de Quantidades e Custos de pregao eletronico.
// Formato inline (1 item = 1 linha):
//   <num> <ipm> <catmat> <DESCRICAO> <Und> <qtde> <preco_unit> <preco_total>
// Cabecalho repetido por pagina. Separadores de grupo entre blocos.
// Descricao pode conter travessoes (—), barras (/), numeros e acentos.
// Caso visto: PE 36/2026 Araucaria-PR (7525803), 67 itens em 3 grupos.
const RX_I_ITEM = /^(\d{1,3})\s+\d+\s+\d+\s+(.*?)\s+(Und|UN|UND|Unid|UNID|Conjunto|Par|Pares|Kit|KIT|Jogo|Cx|CX|Pç|PC|Pct|PCT|Rl|RL|Metro|MT|Resma|Rolo|Frasco|Litro|LT|Bloco|Placa|Folha|Bobina|Bisnaga|Centena|Cartela|Embalagem)\s+([\d.]+)\s+[\d.,]+\s+[\d.,]+\s*$/i;
const parserIPMCatmatDescUndQtd = {
  id: "tr-item-ipm-catmat-desc-und-qtd",
  detectar: (texto) =>
    /ITEM\s+IPM\s+CATMAT\s+DESCRI[ÇC][AÃ]O\s+UND\.?\s+QTDE/.test(texto),
  parsear: (texto) => {
    // Recortar do primeiro cabecalho ate o fim da tabela
    const cabRx = /ITEM\s+IPM\s+CATMAT\s+DESCRI[ÇC][AÃ]O\s+UND\.?\s+QTDE/g;
    const mCab = cabRx.exec(texto);
    if (!mCab) return [];
    const ini = mCab.index;

    // Fim da tabela: "Obs.:" ou "DISPOSIÇÕES PRELIMINARES" ou secao 2/3 pos-tabela
    const fimMarcas = [
      "Obs.:",
      "DISPOSIÇÕES PRELIMINARES",
      "2. DISPOSIÇÕES PRELIMINARES",
      "\n2. DISPOSIÇÕES",
      "\n3. ESPECIFICAÇÃO DO OBJETO",
    ];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 50);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(ini, fim);

    // Remover cabecalhos repetidos e separadores de grupo
    corte = corte.replace(/ITEM\s+IPM\s+CATMAT\s+DESCRI[ÇC][AÃ]O\s+UND\.?\s+QTDE\s+UNIT[AÁ]RIO\s+TOTAL\s*/g, "\n");
    corte = corte.replace(/GRUPO\s+\d+\s*[-–—]\s*[^\n]*/g, "\n");
    // Remover numeros de pagina soltos (ex: "34", "35", "36")
    corte = corte.replace(/\n\d{1,3}\s*\n{2,}/g, "\n");
    // Colapsar linhas vazias
    corte = corte.replace(/\n{3,}/g, "\n\n");

    const itens = [];
    for (const raw of corte.split(/\r?\n/)) {
      const linha = raw.trim();
      if (!linha) continue;
      const m = linha.match(RX_I_ITEM);
      if (!m) continue;
      const quantidade = Number(m[4].replace(/\./g, ""));
      const descricao = m[2].replace(/\s+/g, " ").trim();
      const unidade = m[3];
      if (!descricao || !quantidade) continue;
      itens.push({ quantidade, unidade, descricao });
    }
    return itens;
  },
};

// Layout J: "ITEM ESPECIFICAÇÃO CATMAT\nCÓDIGO\n\nIPM\nQUANT.\n\nUNIDADE\nDE\n\nMEDIDA"
// Tabela de TR hospitalar (FSNH). Cada item:
//   <N>\n\n<desc multiline> <CATMAT_5-6dig> <QTD> <Unidade|unidade>
// O CATMAT+QTD+Unidade podem estar colados no final da ultima linha de descricao
// ou em linha propria. A descricao pode ser cortada pelo rodape de pagina e continuar
// apos ele (ex: item 30 "ORGAO\n<rodape>\nREGULADOR").
// Rodape intercalado: "P á g i n a  N | N" + "FUNDAÇÃO DE SAÚDE PÚBLICA..."
// Fim da tabela: "2. DEFINIÇÃO DO OBJETO" ou secao 2/3 pos-tabela.
// Caso visto: TR FSNH Novo Hamburgo-RS (7526419), 30 itens escovas/esponjas CME.
const RX_J_RODAPE = /P\s*á\s*g\s*i\s*n\s*a\s+\d+\s*\|\s*\d+\s*\n[\s\S]*?www\.fsnh\.net\.br\s*\n?/g;
const RX_J_CATMAT_QTD = /(\d{5,6})\s+(\d+)\s*\n?\s*(Unidade|unidade)\s*$/;
const parserTREspecCatmatQtdUnidade = {
  id: "tr-espec-catmat-qtd-unidade",
  detectar: (texto) =>
    texto.includes("ITEM ESPECIFICAÇÃO CATMAT") &&
    /QUANT\.\s*\n/.test(texto) &&
    /UNIDADE\s*\nDE/.test(texto),
  parsear: (texto) => {
    // Recortar do cabecalho ate a secao pos-tabela
    const ini = texto.indexOf("ITEM ESPECIFICAÇÃO CATMAT");
    if (ini < 0) return [];
    const fimMarcas = [
      "2. DEFINIÇÃO DO OBJETO",
      "2. DEFINICAO DO OBJETO",
      "\n2. ",
      "\n3. ",
    ];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 30);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(ini, fim);

    // Remover rodapes de pagina intercalados
    corte = corte.replace(RX_J_RODAPE, "\n");
    // Remover o cabecalho (tudo ate MEDIDA)
    corte = corte.replace(
      /ITEM ESPECIFICAÇÃO CATMAT[\s\S]*?MEDIDA\s*\n?/,
      "\n",
    );
    // Colapsar linhas vazias
    corte = corte.replace(/\n{3,}/g, "\n\n").trim();

    // Split por inicio de item: numero (1-2 digitos) no inicio de linha seguido de
    // quebra de linha ou espaco + letra maiuscula (inicio da descricao).
    // O numero pode estar sozinho na linha ("1\n\n") ou inline ("7 ESCOVA...")
    const blocos = corte.split(/\n(?=\d{1,2}\s*\n|\d{1,2}\s+[A-ZÁÀÃÉÊÍÓÔÚÇ])/);
    const itens = [];

    for (const bloco of blocos) {
      const raw = bloco.trim();
      if (!raw) continue;
      // Extrair numero do item no inicio
      const mNum = raw.match(/^(\d{1,2})\s+([\s\S]*)/s);
      if (!mNum) continue;
      const num = Number(mNum[1]);
      if (num < 1 || num > 99) continue;

      let corpo = mNum[2].trim();

      // Encontrar CATMAT+QTD+Unidade no corpo
      const mCat = corpo.match(/(\d{5,6})\s+(\d+)\s*\n?\s*(Unidade|unidade)/);
      if (!mCat) continue;

      const quantidade = Number(mCat[2]);
      const unidade = mCat[3];

      // Descricao: tudo antes do CATMAT (o CATMAT marca o fim da descricao)
      // Tambem pegar texto APOS o match CATMAT+QTD+Unidade (continuacao pos-rodape)
      const catIdx = corpo.indexOf(mCat[0]);
      const antes = corpo.slice(0, catIdx).trim();
      const depois = corpo.slice(catIdx + mCat[0].length).trim();

      // Descricao = antes + depois (se houver continuacao)
      let descricao = antes;
      if (depois) descricao += " " + depois;
      descricao = descricao.replace(/\s+/g, " ").trim();

      if (!descricao || !quantidade) continue;
      itens.push({ quantidade, unidade, descricao });
    }
    return itens;
  },
};

// Layout K: "CÓD. DISCRIMINAÇÃO UNIDADE QUANTIDADE PREÇO UNIT. PREÇO TOTAL"
// Tabela resumo de licitacao de servicos terceirizados com dedicacao de mao de obra.
// Formato inline (1 item por linha):
//   <num> <descricao> <UNIDADE_EXTENSO> <qtd_com_ponto_milhar> <preco_unit_virgula> R$ <total>
//   ex: "1 AUXILIAR DE EDUCAÇÃO ESPECIAL HORAS 26.400 25,94 R$ 684.816,00"
// Fim da tabela: "Total do Lote" ou linha vazia seguida de secao.
// Caso visto: PE 002/2026 FME Custodia-PE (7527296), 2 itens servico.
const RX_K_ITEM = /^(\d{1,3})\s+(.+?)\s+(HORAS|HORA|MES|MESES|MENSAL|DIÁRIA|DIARIA|POSTOS?|SERVIÇO|SERVICO|UND|UN)\s+([\d.]+)\s+[\d.,]+\s+R\$/i;
const parserCodDiscriminacaoServico = {
  id: "cod-discriminacao-servico",
  detectar: (texto) =>
    /C[ÓO]D\.?\s+DISCRIMINA[ÇC][ÃA]O\s+UNIDADE\s+QUANTIDADE\s+PRE[ÇC]O\s+UNIT/.test(texto),
  parsear: (texto) => {
    // Recortar do cabecalho ate "Total do Lote" ou secao seguinte
    const cabMatch = texto.match(/C[ÓO]D\.?\s+DISCRIMINA[ÇC][ÃA]O\s+UNIDADE\s+QUANTIDADE\s+PRE[ÇC]O\s+UNIT[^\n]*/);
    if (!cabMatch) return [];
    const ini = cabMatch.index + cabMatch[0].length;
    const fimMarcas = ["Total do Lote", "TOTAL DO LOTE", "DETALHAMENTO", "\n4.", "\n5."];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini);
      if (i >= 0 && i < fim) fim = i;
    }
    const corte = texto.slice(ini, fim);

    const itens = [];
    for (const raw of corte.split(/\r?\n/)) {
      const linha = raw.trim();
      if (!linha) continue;
      const m = linha.match(RX_K_ITEM);
      if (!m) continue;
      const quantidade = Number(m[4].replace(/\./g, ""));
      const descricao = m[2].replace(/\s+/g, " ").trim();
      const unidade = m[3];
      if (!descricao || !quantidade) continue;
      itens.push({ quantidade, unidade, descricao });
    }
    return itens;
  },
};

// Layout L: "Item Especificação Unidade\nde medida\nQuant."
// Tabela de TR hospitalar com itens numerados "N." (numero + ponto + espaços).
// Formato:
//   <N>.  \n<TITULO>\n<descricao multilinhas>\n<UNIDADE> <QTD>
//   ou inline: <N>.  <TITULO> <UNIDADE> <QTD>
// Unidades: KG, PCT, CX, UND, LATA (maiusculas, 2-4 chars).
// Quantidade pode ter ponto de milhar (ex: 1.500, 6.300).
// Caso especial: unidade e quantidade separados por quebra (ex: "PCT\n\n300").
// Rodape de pagina intercalado: "HOSPITAL MUNICIPAL DE BOCAIUVA\nDR. GIL ALVES..."
// Fim da tabela: secao "2.1." ou "3.0." apos o ultimo item.
// Caso visto: TR Hospital Municipal Bocaiuva-MG (7527300), 102 itens alimenticios.
const RX_L_UNIDADES = /^(KG|PCT|CX|UND|LATA)$/i;
const RX_L_UNID_QTD = /\b(KG|PCT|CX|UND|LATA)\s+([\d.]+)\s*$/i;
const RX_L_RODAPE = /HOSPITAL MUNICIPAL DE BOCAI[UÚ]VA\s*\n.*?DR\.\s*GIL ALVES[^\n]*\n[\s\S]*?Bocai[uú]va\/MG[^\n]*\n\s*\n?\s*/g;
const parserTRItemEspecUnidQuant = {
  id: "tr-item-espec-unid-quant",
  detectar: (texto) =>
    /Item\s+Especifica[çc][ãa]o\s+Unidade/.test(texto) &&
    /Quant\./.test(texto) &&
    /\d{1,3}\.\s{1,4}\n/.test(texto),
  parsear: (texto) => {
    // Recortar: do cabecalho ate secao 2.1 ou 3.0
    const cabMatch = texto.match(/Item\s+Especifica[çc][ãa]o\s+Unidade/);
    if (!cabMatch) return [];
    const ini = cabMatch.index;
    const fimMarcas = ["\n2.1.", "\n3.0.", "\n3.0 ", "\n2.1 "];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 30);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(ini, fim);

    // Remover rodapes de pagina intercalados
    corte = corte.replace(RX_L_RODAPE, "\n");
    // Remover cabecalho da tabela (Item Especificacao ... Quant.)
    corte = corte.replace(/Item\s+Especifica[çc][ãa]o\s+Unidade[\s\S]*?Quant\.\s*\n?/, "\n");
    // Colapsar linhas vazias
    corte = corte.replace(/\n{3,}/g, "\n\n").trim();

    // Split por inicio de item: "N." no inicio de linha (1-3 digitos + ponto + espaço(s))
    const blocos = corte.split(/\n(?=\d{1,3}\.\s)/);
    const itens = [];

    for (const bloco of blocos) {
      const raw = bloco.trim();
      if (!raw) continue;

      // Extrair numero do item: "N. " ou "N.  "
      const mNum = raw.match(/^(\d{1,3})\.\s+([\s\S]*)/);
      if (!mNum) continue;
      const num = Number(mNum[1]);
      if (num < 1 || num > 999) continue;

      let corpo = mNum[2].trim();

      // Caso 1: unidade+qtd na MESMA linha (Tika colou coluna)
      // ex: "AZEITONA VERDE 500G UND 80\n\nAzeitona em conserva..."
      // ou no final do corpo inteiro
      // Procurar UNID QTD no final do corpo (ultima ocorrencia)
      const linhas = corpo.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

      let unidade = null;
      let quantidade = null;
      let unidLinha = -1;

      // Procurar de tras pra frente a linha ou final de linha com UNID QTD
      for (let i = linhas.length - 1; i >= 0; i--) {
        // Caso A: linha INTEIRA e "UNID QTD"
        const mLinha = linhas[i].match(/^(KG|PCT|CX|UND|LATA)\s+([\d.]+)\s*$/i);
        if (mLinha) {
          unidade = mLinha[1].toUpperCase();
          quantidade = Number(mLinha[2].replace(/\./g, ""));
          unidLinha = i;
          break;
        }
        // Caso B: UNID QTD no FINAL de uma linha de texto
        // ex: "AZEITONA VERDE 500G UND 80"
        const mFim = linhas[i].match(/^(.*?)\s+(KG|PCT|CX|UND|LATA)\s+([\d.]+)\s*$/i);
        if (mFim) {
          unidade = mFim[2].toUpperCase();
          quantidade = Number(mFim[3].replace(/\./g, ""));
          // Manter a parte antes da unidade como descricao
          linhas[i] = mFim[1].trim();
          unidLinha = i + 1; // descricao inclui esta linha (ja limpa)
          break;
        }
        // Caso C: UNID sozinha na linha, QTD na proxima linha nao-vazia
        if (RX_L_UNIDADES.test(linhas[i])) {
          unidade = linhas[i].toUpperCase();
          // Procurar quantidade nas linhas seguintes
          for (let k = i + 1; k < linhas.length; k++) {
            if (/^\d[\d.]*$/.test(linhas[k])) {
              quantidade = Number(linhas[k].replace(/\./g, ""));
              unidLinha = i; // descricao vai ate ANTES da unidade
              break;
            }
          }
          if (quantidade != null) break;
          // Nao encontrou quantidade: nao e unidade, e parte da descricao
          unidade = null;
        }
      }

      if (quantidade == null) continue;

      // Descricao: tudo antes da linha de unidade
      const descLinhas = linhas.slice(0, unidLinha);
      const descricao = descLinhas.join(" ").replace(/\s+/g, " ").trim();
      if (!descricao) continue;

      itens.push({ quantidade, unidade, descricao });
    }
    return itens;
  },
};

// Layout M: "Item Descrição UND Qtde" — Modelo de Proposta de Precos de edital hospitalar.
// Formato: "0NNN\n\nTITULO: desc multilinhas\n\nunidade qtd,00 0,00 preco PART"
// Item number: 4 digitos zero-padded (0001, 0002, ..., 0103).
// Descricao: "TITULO: descricao..." multilinhas (Tika quebra colunas do PDF).
// Unidade: extenso lowercase ("quilograma", "pacote", "caixa", "unidade", "lata").
// Quantidade: com virgula e 2 decimais ("360,00", "1.100,00").
// Rodape de pagina intercalado: "HOSPITAL MUNICIPAL DE BOCAIUVA\nDR. GIL ALVES..."
// Cabecalho do anexo: "ANEXO I – PROPOSTA DE PREÇOS (MODELO)"
// Caso visto: Edital PE 022/2026 Hospital Bocaiuva-MG (7527300), 103 itens.
const RX_M_RODAPE = /HOSPITAL MUNICIPAL DE BOCAI[UÚ]VA\s*\n.*?DR\.\s*GIL ALVES[^\n]*\n[\s\S]*?Bocai[uú]va\/MG[^\n]*\n\s*\n?\s*/g;
const RX_M_UNID_QTD = /^(quilograma|pacote|caixa|unidade|lata|litro)\s+([\d.]+),\d{2}\s+/i;
const parserPropostaPrecos = {
  id: "edital-proposta-precos-und-qtd",
  detectar: (texto) =>
    /PROPOSTA DE PRE[ÇC]OS\s*\(MODELO\)/.test(texto) &&
    /Item Descri[çc][ãa]o\s+UND\s+Qtde/.test(texto) &&
    /\n0001\s*\n/.test(texto),
  parsear: (texto) => {
    // Recortar: do inicio da tabela (cabecalho "Item Descrição UND Qtde") ate o fim
    const cabMatch = texto.match(/Item Descri[çc][ãa]o\s+UND\s+Qtde/);
    if (!cabMatch) return [];
    const ini = cabMatch.index;
    // Fim: secao pos-tabela ou fim do texto
    const fimMarcas = [
      "\nValor Total",
      "\nVALOR TOTAL",
      "\nDECLARAMOS",
      "\nDeclaramos",
      "\nOBS:",
      "\nNota:",
    ];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 50);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(ini, fim);

    // Remover rodapes de pagina intercalados
    corte = corte.replace(RX_M_RODAPE, "\n");
    // Remover cabecalhos de tabela repetidos (ex: "Item Descrição UND Qtde\nValor\nUnitário...")
    corte = corte.replace(/Item Descri[çc][ãa]o\s+UND\s+Qtde[\s\S]*?Ampla\s*\n?/gi, "\n");
    // Remover linhas do ANEXO I (cabecalho repetido entre paginas)
    corte = corte.replace(/ANEXO I [–—-] PROPOSTA DE PRE[ÇC]OS \(MODELO\)\s*\n?/gi, "\n");
    // Colapsar linhas vazias
    corte = corte.replace(/\n{3,}/g, "\n\n").trim();

    // Split por inicio de item: "\n0NNN\n" (4 digitos no inicio de linha, sozinho)
    const blocos = corte.split(/\n(?=0{0,2}\d{1,4}\s*\n)/);
    const itens = [];

    for (const bloco of blocos) {
      const raw = bloco.trim();
      if (!raw) continue;

      // Extrair numero do item: "0001" ou "0103" sozinho na primeira linha
      const mNum = raw.match(/^(0{0,2}\d{1,4})\s*\n([\s\S]*)/);
      if (!mNum) continue;
      const num = Number(mNum[1]);
      if (num < 1 || num > 999) continue;

      // O Tika pode quebrar a unidade em 2 linhas (ex: "quilogra\nma\n360,00").
      // Juntar o corpo em texto corrido e normalizar unidades quebradas pelo Tika.
      const corpo = mNum[2].trim();
      const corpoJoined = corpo.replace(/\n/g, " ").replace(/\s+/g, " ")
        .replace(/quilogra\s+ma\b/gi, "quilograma")
        .replace(/unida\s+de\b/gi, "unidade")
        .replace(/paco\s+te\b/gi, "pacote");
      const mUQ = corpoJoined.match(
        /^([\s\S]*?)\s+(quilograma|pacote|caixa|unidade|lata|litro)\s+([\d.]+),\d{2}\s+/i,
      );
      if (!mUQ) continue;

      const unidade = mUQ[2].toUpperCase();
      const quantidade = Number(mUQ[3].replace(/\./g, ""));

      // Descricao: tudo antes da unidade (capturado pelo grupo 1)
      const descricao = mUQ[1]
        .replace(/\s+/g, " ")
        .trim();
      if (!descricao || !quantidade) continue;

      itens.push({ quantidade, unidade, descricao });
    }
    return itens;
  },
};

// Layout N: DFD Abase — "Lote/Item Unid Quantidade Qtd min. Produto / Descrição"
// Pedido de compra do sistema Abase Sistemas e Soluções LTDA.
// Formato de item:
//   000/001 UN 1,0000000000 0,00 00019161 - PLANTADEIRA
//   Descrição adicional:
//   <descricao multiline longa>
//   Dotação:...
// Quantidade com 10 casas decimais (ex: 1,0000000000). Qtd min. (0,00) e codigo sao ignorados.
// A descricao util = titulo (apos o traco na linha do item) + corpo apos "Descrição adicional:".
// Fim do item: proxima linha "000/NNN" ou "Dotação:" ou "ESTUDO TÉCNICO" ou fim do texto.
// Caso visto: DFD Pedido de compra Porto Mauá-RS (7528503), 2 itens maquinario agricola.
const RX_N_ITEM = /^(0{1,3}\/\d{1,3})\s+(\S+)\s+([\d.]+),\d{2,10}\s+[\d.,]+\s+\d+\s*[-–]\s*(.+)$/;
const parserDFDAbase = {
  id: "dfd-abase-lote-item-unid-qtd",
  detectar: (texto) =>
    texto.includes("Lote/Item Unid Quantidade Qtd min.") &&
    texto.includes("Produto / Descri"),
  parsear: (texto) => {
    // recortar da tabela (cabecalho) ate "ESTUDO TÉCNICO" ou fim
    const ini = texto.indexOf("Lote/Item Unid Quantidade Qtd min.");
    if (ini < 0) return [];
    const fimMarcas = ["ESTUDO TÉCNICO", "ESTUDO TECNICO"];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 30);
      if (i >= 0 && i < fim) fim = i;
    }
    const corte = texto.slice(ini, fim);

    // split por inicio de item: "000/NNN" no inicio de linha
    const blocos = corte.split(/\n(?=0{1,3}\/\d{1,3}\s)/);
    const itens = [];

    for (const bloco of blocos) {
      const linhas = bloco.split("\n");
      const primeiraLinha = linhas[0].trim();
      const m = primeiraLinha.match(RX_N_ITEM);
      if (!m) continue;

      const unidade = m[2].trim();
      const quantidade = Number(m[3].replace(/\./g, ""));
      const titulo = m[4].trim();

      // Corpo: texto apos "Descrição adicional:" ate "Dotação:" ou proximo item
      const textoBloco = bloco;
      const descAdicIdx = textoBloco.indexOf("Descrição adicional:");
      let corpo = "";
      if (descAdicIdx >= 0) {
        const apos = textoBloco.slice(descAdicIdx + "Descrição adicional:".length);
        // cortar no primeiro "Dotação:" ou fim
        const dotIdx = apos.indexOf("Dotação:");
        corpo = dotIdx >= 0 ? apos.slice(0, dotIdx) : apos;
      }

      const descricao = [titulo, corpo.replace(/\s+/g, " ").trim()]
        .filter(Boolean)
        .join(": ")
        .replace(/\s+/g, " ")
        .trim();

      if (!descricao || !quantidade) continue;
      itens.push({ quantidade, unidade, descricao });
    }
    return itens;
  },
};

// Layout O: Edital ANEXO II Porto Mauá — "PARTICIP. ITEM DESCRIÇÃO QTDE UN"
// Tabela de especificações do objeto em edital de pregão eletrônico.
// Formato Tika (colunas viram linhas):
//   AMPLA\nCOMP.\n\n \n1 \n\nPLANTADEIRA:\n<desc multiline>\n\n1 UN \n\nR$ \n106.333,33
//   ME/EPP\n\n \n2 \n\nANCINHO ENLEIRADOR:\n<desc multiline>\n\n2 UN \nR$\n31.830,00
// O numero do item aparece como "<N> \n" (sozinho ou "<N> \n<desc>").
// Apos a descricao multiline: "<qtde> UN" (qtde + unidade na mesma linha) + precos R$.
// Detectar: "PARTICIP." + "ITEM" + "DESCRIÇÃO" + "QTDE" + "UN" no cabecalho.
// Fim da tabela: "VALOR TOTAL:" apos a tabela.
// Caso visto: Edital PE 26/2026 Porto Mauá-RS (7528503), 2 itens.
const parserEditalAnexoParticip = {
  id: "edital-anexo-particip-item-desc-qtd",
  detectar: (texto) =>
    /PARTICIP\.\s+ITEM\s+DESCRI[ÇC][ÃA]O\s+QTDE\s+UN/.test(texto) &&
    texto.includes("VALOR TOTAL:"),
  parsear: (texto) => {
    // Encontrar a primeira tabela (ANEXO II, nao ANEXO III que e modelo de proposta vazio)
    const cabRx = /PARTICIP\.\s+ITEM\s+DESCRI[ÇC][ÃA]O\s+QTDE\s+UN/g;
    const mCab = cabRx.exec(texto);
    if (!mCab) return [];
    const ini = mCab.index;

    // Fim: primeiro "VALOR TOTAL:" apos o cabecalho
    const fimIdx = texto.indexOf("VALOR TOTAL:", ini + 30);
    if (fimIdx < 0) return [];
    const corte = texto.slice(ini, fimIdx);

    // Remover rodape de pagina intercalado (URL + header municipio)
    const limpo = corte
      .replace(/http:\/\/www\.\S+\s*/g, " ")
      .replace(/ESTADO DO RIO GRANDE DO SUL[\s\S]*?"Doe Órgãos, Doe Sangue: Salve Vidas"\s*\n?\s*\n?\s*\d*\s*\n?/g, "\n")
      .replace(/\n{3,}/g, "\n\n");

    // Estrategia: encontrar blocos que comecam com participacao (AMPLA|ME/EPP) + numero
    // ou diretamente com numero apos o cabecalho.
    // Cada item tem: <participacao>\n...\n<numero>\n\n<TITULO>:\n<desc>\n\n<qtde> UN\n...R$
    const itens = [];

    // Regex para capturar "<qtde> <unidade>" antes de "R$" (marca fim da descricao)
    // O Tika pode colocar na forma "1 UN " ou "2 UN\n"
    const rxQtdUnid = /\n(\d+)\s+(UN|UND|Und|un|und)\s*\n/g;

    // Encontrar todas as posicoes de qtd+unid
    const qtdPositions = [];
    let mq;
    while ((mq = rxQtdUnid.exec(limpo)) !== null) {
      qtdPositions.push({ idx: mq.index, qtd: Number(mq[1]), unid: mq[2], endIdx: mq.index + mq[0].length });
    }

    // Para cada qtd+unid encontrada, procurar o numero do item e a descricao ANTES dele
    for (const pos of qtdPositions) {
      // Trecho antes do qtd+unid
      const antes = limpo.slice(0, pos.idx);

      // Procurar o numero do item: ultimo "<participacao>...<N>" ou "<N>\n" antes
      // O numero aparece como "\n<N> \n" ou "\n<N>\n" com participacao antes
      // Vamos procurar o ultimo numero sozinho na linha
      const rxNum = /\n\s*(\d{1,3})\s*\n/g;
      let ultimoNum = null;
      let ultimoNumEnd = -1;
      let mn;
      while ((mn = rxNum.exec(antes)) !== null) {
        ultimoNum = Number(mn[1]);
        ultimoNumEnd = mn.index + mn[0].length;
      }
      if (ultimoNum == null) continue;

      // Descricao: do fim do numero ate o inicio do qtd+unid
      let descricao = antes.slice(ultimoNumEnd, antes.length)
        .replace(/\s+/g, " ")
        .trim();

      // Limpar artefatos: remover AMPLA COMP. / ME/EPP do inicio da descricao
      descricao = descricao
        .replace(/^(?:AMPLA\s*COMP\.?\s*|ME\/EPP\s*)/i, "")
        .trim();

      if (!descricao || !pos.qtd) continue;
      itens.push({ quantidade: pos.qtd, unidade: pos.unid, descricao });
    }
    return itens;
  },
};

// Layout P: "CÓDIGO DESCRIÇÃO DO ITEM UNIDADE QUANTIDADE [P.UNITÁRIO P. TOTAL]"
// Tabela padrao de edital PE (Pernambuco). Prefixo opcional DFD/ETP antes do numero.
// Formato de item:
//   [DFD|ETP] <N> <descricao> <Unidade|km|un|...> <quantidade> [<preco_unit> <preco_total>]
// Descricao pode ser MULTILINE: o item continua nas linhas seguintes ate a unidade+quantidade
// aparecer em linha separada (ex: "Unidade 25" isolado na proxima linha para item longo).
// Preco e opcional (presente na tabela do quadro comparativo, ausente no DFD/ETP/TR).
// Cabecalho repetido por secao do PDF composto (DFD, ETP, TR, Edital no mesmo arquivo).
// Fim da tabela: "Total do Lote:" ou secao pos-tabela ("4.0." / "4.1." / "4.2.").
// Caso visto: PE 009/2026 Tabira-PE (7530292), 9 itens ataud/translado.
// UNIDADES aceitas pelo parser: extenso ("Unidade", "quilômetro", "metro") ou sigla curta ("km", "un", "und").
const RX_P_UNID_QTD = /\b(Unidade|unidade|UNIDADE|un|UN|UND|und|km|Km|KM|metro|Metro|METRO)\s+([\d.]+)\s*$/;
const RX_P_UNID_QTD_PRECO = /\b(Unidade|unidade|UNIDADE|un|UN|UND|und|km|Km|KM|metro|Metro|METRO)\s+([\d.]+)\s+[\d.,]+\s+[\d.,]+\s*$/;
const parserCodigoDescItemUnidQtd = {
  id: "codigo-desc-item-unid-qtd",
  detectar: (texto) =>
    /C[ÓO]DIGO\s+DESCRI[ÇC][ÃA]O\s+DO\s+ITEM\s+UNIDADE\s+QUANTIDADE/.test(texto),
  parsear: (texto) => {
    // Encontrar TODAS as tabelas (cabecalho repetido por secao) e pegar a PRIMEIRA
    // que tem itens parseados com sucesso
    const cabRx = /C[ÓO]DIGO\s+DESCRI[ÇC][ÃA]O\s+DO\s+ITEM\s+UNIDADE\s+QUANTIDADE[^\n]*/g;
    let mCab;
    const tabelas = [];
    while ((mCab = cabRx.exec(texto)) !== null) {
      tabelas.push(mCab.index + mCab[0].length);
    }
    if (!tabelas.length) return [];

    // Tentar cada tabela e pegar a que retornar mais itens
    let melhorItens = [];
    for (let tIdx = 0; tIdx < tabelas.length; tIdx++) {
      const ini = tabelas[tIdx];
      // Fim da tabela: proximo cabecalho OU marcas de secao (o que vier primeiro)
      const proxCab = tIdx + 1 < tabelas.length ? tabelas[tIdx + 1] - 50 : texto.length;
      const fimMarcas = ["Total do Lote", "TOTAL:", "\n4.0.", "\n4.1.", "\n4.2.", "\n5.0."];
      let fim = proxCab;
      for (const mk of fimMarcas) {
        const i = texto.indexOf(mk, ini);
        if (i >= 0 && i < fim) fim = i;
      }
      const corte = texto.slice(ini, fim).trim();
      if (!corte) continue;

      // Split por inicio de item: [DFD|ETP]? <N> no inicio de linha
      // Formato: linha comecando com prefixo opcional + numero 1-3 digitos + espaco + texto
      const blocos = corte.split(/\n(?=(?:DFD|ETP|TR)?\s*\d{1,3}\s+[A-ZÁÀÃÉÊÍÓÔÚÇ])/i);
      const itens = [];

      for (const bloco of blocos) {
        const raw = bloco.trim();
        if (!raw) continue;

        // Extrair numero: [DFD|ETP] <N> <resto>
        const mNum = raw.match(/^(?:DFD|ETP|TR)?\s*(\d{1,3})\s+([\s\S]*)/i);
        if (!mNum) continue;
        const num = Number(mNum[1]);
        if (num < 1 || num > 999) continue;

        let corpo = mNum[2];

        // Juntar todas as linhas do corpo (a descricao pode ser multiline)
        // e procurar UNID QTD (com ou sem preco apos) do FINAL para o inicio
        const linhas = corpo.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

        let unidade = null;
        let quantidade = null;
        let descEndIdx = -1;

        // Procurar de tras pra frente a UNIDADE+QTD
        for (let i = linhas.length - 1; i >= 0; i--) {
          // Caso A: linha INTEIRA e "Unidade 25" (unidade + qtd pura)
          const mUQ = linhas[i].match(/^\s*(Unidade|unidade|UNIDADE|un|UN|UND|und|km|Km|KM|metro|Metro|METRO)\s+([\d.]+)\s*$/);
          if (mUQ) {
            unidade = mUQ[1];
            quantidade = Number(mUQ[2].replace(/\./g, ""));
            descEndIdx = i; // descricao vai ate ANTES desta linha
            break;
          }
          // Caso B: "Unidade 25 preco_unit preco_total" (com precos na mesma linha)
          const mUQP = linhas[i].match(/^\s*(Unidade|unidade|UNIDADE|un|UN|UND|und|km|Km|KM|metro|Metro|METRO)\s+([\d.]+)\s+[\d.,]+\s+[\d.,]+\s*$/);
          if (mUQP) {
            unidade = mUQP[1];
            quantidade = Number(mUQP[2].replace(/\./g, ""));
            descEndIdx = i;
            break;
          }
          // Caso C: UNID+QTD no FINAL de uma linha de texto
          // ex: "ATAÚDE (0 A 60 CM) Unidade 10"
          const mFim = linhas[i].match(/^(.*?)\s+(Unidade|unidade|UNIDADE|un|UN|UND|und|km|Km|KM|metro|Metro|METRO)\s+([\d.]+)\s*$/);
          if (mFim) {
            unidade = mFim[2];
            quantidade = Number(mFim[3].replace(/\./g, ""));
            // Manter a parte antes da unidade como descricao
            linhas[i] = mFim[1].trim();
            descEndIdx = i + 1; // descricao inclui esta linha (ja limpa)
            break;
          }
          // Caso D: UNID+QTD+PRECO no final de uma linha
          const mFimP = linhas[i].match(/^(.*?)\s+(Unidade|unidade|UNIDADE|un|UN|UND|und|km|Km|KM|metro|Metro|METRO)\s+([\d.]+)\s+[\d.,]+\s+[\d.,]+\s*$/);
          if (mFimP) {
            unidade = mFimP[2];
            quantidade = Number(mFimP[3].replace(/\./g, ""));
            linhas[i] = mFimP[1].trim();
            descEndIdx = i + 1;
            break;
          }
        }

        if (quantidade == null || descEndIdx < 0) continue;

        // Descricao: tudo antes da unidade+qtd
        const descLinhas = linhas.slice(0, descEndIdx);
        const descricao = descLinhas.join(" ").replace(/\s+/g, " ").trim();
        if (!descricao) continue;

        itens.push({ quantidade, unidade, descricao });
      }

      if (itens.length > melhorItens.length) melhorItens = itens;
    }
    return melhorItens;
  },
};

// Layout Q: TR com itens numerados "N.NN" (lote.sequencial) — tabela por LOTES.
// Cabecalho de tabela: "Item Descrição Quantida" (Tika quebra "Quantidade" em 2 linhas).
// Formato de item (Tika coluna por coluna):
//   N.NN
//   <descricao multilinhas>
//   <espacos/linhas vazias do gap de coluna>
//   <QTD>                              -- inteiro ou com ponto de milhar (30.000)
//   [(anotacao)]                       -- opcional: "(sacos)", "( pacotes\nde 100\nunidades)"
//   <PRECO>                            -- virgula decimal (33,46)
// Variante inline (Tika sem quebra de coluna): "QTD PRECO" na mesma linha (ex: "10 20,43").
// Separadores de lote: "LOTE NN -..." e "Total Lote N" / "Total lote N".
// Rodape de pagina intercalado: "MUNICIPIO DE IVOTI" / "Secretaria Municipal de Educacao".
// Fim da tabela: secao "6. DA ENTREGA" ou "6.DA ENTREGA".
// Caso visto: TR Secretaria de Educacao Ivoti-RS (7531044), 127 itens em 8 lotes.
const RX_Q_RODAPE = /MUNIC[ÍI]PIO DE IVOTI\s*\n[\s\S]*?Secretaria Municipal de Educa[çc][ãa]o\s*\n\s*\n?/g;
const parserTRLoteItemIvoti = {
  id: "tr-lote-item-ivoti",
  detectar: (texto) =>
    /Rela[çc][ãa]o dos materiais:/.test(texto) &&
    /LOTE\s+\d{2}\s*-/.test(texto) &&
    /\d\.\d{2}\s/.test(texto) &&
    /Total [Ll]ote \d/i.test(texto),
  parsear: (texto) => {
    // Recortar: de "Relacao dos materiais:" ate "6. DA ENTREGA" ou fim
    const ini = texto.search(/Rela[çc][ãa]o dos materiais:/);
    if (ini < 0) return [];
    const fimMarcas = ["6. DA ENTREGA", "6.DA ENTREGA", "6 . DA ENTREGA"];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 20);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(ini, fim);

    // Remover rodapes de pagina intercalados
    corte = corte.replace(RX_Q_RODAPE, "\n");
    // Remover cabecalhos de tabela repetidos (Item Descricao Quantida / de / Valor unit)
    corte = corte.replace(/Item\s+Descri[çc][ãa]o\s+Quantida\s*\n\s*de\s*\n\s*Valor unit\s*\n?/gi, "\n");
    // Remover linhas de separador de lote "LOTE NN - ..." e totais "Total Lote/lote N"
    corte = corte.replace(/LOTE\s+\d{2}\s*-[^\n]*/g, "\n");
    corte = corte.replace(/Total\s+[Ll]ote\s+\d+\s+[\d.,]+\s*/g, "\n");
    // Colapsar linhas de espaco-apenas para linhas vazias reais
    corte = corte.split("\n").map((l) => (/^\s+$/.test(l) ? "" : l)).join("\n");
    // Colapsar linhas vazias multiplas
    corte = corte.replace(/\n{3,}/g, "\n\n").trim();

    // Split por inicio de item: "N.NN" no inicio de linha (sozinho ou com espaco antes/depois)
    // Tambem capturar 3.05 que o Tika colou com texto: "3.05 Prato de sopa..."
    const blocos = corte.split(/\n(?=\s*\d{1,2}\.\d{2}\s)/);
    const itens = [];

    for (const bloco of blocos) {
      const raw = bloco.trim();
      if (!raw) continue;

      // Extrair numero do item: "N.NN" no inicio
      const mNum = raw.match(/^(\d{1,2})\.(\d{2})\s+([\s\S]*)/s);
      if (!mNum) continue;

      const corpo = mNum[3].trim();
      if (!corpo) continue;

      // Coletar todas as linhas nao-vazias do corpo
      const linhas = corpo.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      if (!linhas.length) continue;

      // Estrategia: procurar de TRAS PRA FRENTE a sequencia PRECO -> [ANOTACAO] -> QTD.
      // O preco e o ultimo elemento significativo (virgula decimal: "33,46", "102,86").
      // A anotacao entre parenteses e opcional.
      // A quantidade e um inteiro (com ou sem ponto de milhar).

      let quantidade = null;
      let descEndIdx = linhas.length; // descricao vai ate aqui (exclusive)

      // Passo 1: encontrar o PRECO de tras pra frente
      let precoIdx = -1;
      for (let i = linhas.length - 1; i >= 0; i--) {
        // Preco puro na linha: "33,46", "102,86", "179,28"
        if (/^[\d.]+,\d{2}\s*$/.test(linhas[i])) {
          precoIdx = i;
          break;
        }
        // Variante inline "QTD PRECO": "10 20,43" (qtd + preco na mesma linha)
        const mInline = linhas[i].match(/^([\d.]+)\s+([\d.]+,\d{2})\s*$/);
        if (mInline) {
          quantidade = Number(mInline[1].replace(/\./g, ""));
          precoIdx = i;
          descEndIdx = i;
          break;
        }
      }
      if (precoIdx < 0) continue; // sem preco = bloco mal-formado

      // Se ja achamos qtd inline, pular para descricao
      if (quantidade != null) {
        const descricao = linhas.slice(0, descEndIdx).join(" ").replace(/\s+/g, " ").trim();
        if (descricao && quantidade) itens.push({ quantidade, descricao });
        continue;
      }

      // Passo 2: do preco para cima, pular anotacoes entre parenteses e encontrar a QTD
      let cursor = precoIdx - 1;

      // Pular anotacoes entre parenteses: linhas que comecam com "(" ou sao continuacao
      // Ex: "(sacos)", "( pacotes", "de 100", "unidades)"
      // Detectar: se cursor aponta para linha que termina com ")" ou comeca com "(", e anotacao
      // Vamos voltar enquanto estivermos dentro de um bloco "(..."...")"
      let parenBlock = false;
      while (cursor >= 0) {
        const cl = linhas[cursor];
        if (cl.endsWith(")") || cl === "(sacos)") {
          // Inicio de bloco paren (lendo de tras pra frente)
          parenBlock = true;
          cursor--;
          continue;
        }
        if (parenBlock && (cl.startsWith("(") || /^[a-z]/.test(cl))) {
          // Continuacao do bloco paren (ex: "( pacotes", "de 100")
          if (cl.startsWith("(")) parenBlock = false; // chegou no inicio
          cursor--;
          continue;
        }
        break;
      }

      // Cursor agora aponta para a linha de quantidade
      if (cursor >= 0) {
        const mQtd = linhas[cursor].match(/^([\d.]+)\s*$/);
        if (mQtd) {
          quantidade = Number(mQtd[1].replace(/\./g, ""));
          descEndIdx = cursor;
        }
      }

      if (quantidade == null) continue;

      const descricao = linhas.slice(0, descEndIdx).join(" ").replace(/\s+/g, " ").trim();
      if (!descricao || !quantidade) continue;

      itens.push({ quantidade, descricao });
    }

    return itens;
  },
};

// Layout R: "Item Descrição  Unidade Medida  Quant."
// Tabela de TR de pregão eletrônico SRP com coluna de código CATMAT 7 dígitos.
// Cada item: "<N>  <CATMAT_7dig> - <desc multiline>  <UNIDADE> <QTD>"
// A unidade+quantidade ficam numa linha separada APÓS (ou no meio, por quebra de
// página Tika) a descrição. Unidade = palavra (UNIDADES, UND, FRASCOS, PACOTES,
// CAIXAS, Litros, Pares, Rolo, Pacote, Und., Unid, Unid., etc.) seguida de
// quantidade inteira (possivelmente com pontos de milhar: 33.780).
// O código CATMAT (ex: 0042435, 0000841) é removido da descrição.
// Quebra de página pode colocar a unidade+qtd NO MEIO da descrição (item 87 do
// aviso 7531921); nesse caso a descrição continua na linha seguinte. O parser
// extrai unidade+qtd e junta as partes da descrição.
// Rodapé de página possível: linhas com "http://..." ou blocos entre itens.
// Fim da tabela: "Orçamento sigiloso" ou "4. PRAZO" ou seção pós-tabela.
// Caso visto: TR Goianinha-RN (7531921), 100 itens.
const RX_R_UNID_QTD = /^(UNIDADES|UNIDADE|UND|FRASCOS|FRASCO|PACOTES|PACOTE|CAIXAS|CAIXA|Litros|Pares|Rolo|Und\.|Unid\.?|Conjunto|FARDOS|FARDO)\s+([\d.]+)\s*$/i;
const RX_R_ITEM_START = /\n(\d{1,3})\s+(\d{7})\s+-\s+/;
const parserTRCatmat7DescUnidQtd = {
  id: "tr-catmat7-desc-unid-qtd",
  detectar: (texto) => {
    // Marca 1: cabeçalho "Item Descrição" + "Quant."
    if (!/Item\s+Descri/i.test(texto)) return false;
    if (!/Quant\./i.test(texto)) return false;
    // Marca 2: pelo menos 3 itens com código CATMAT 7 dígitos
    const matches = texto.match(/\n\d{1,3}\s+\d{7}\s+-\s+/g);
    return matches != null && matches.length >= 3;
  },
  parsear: (texto) => {
    // 1. Encontrar o início da tabela (primeiro item com CATMAT 7 dígitos)
    const firstItem = texto.match(/\n(\d{1,3})\s+\d{7}\s+-\s+/);
    if (!firstItem) return [];
    const ini = firstItem.index;

    // 2. Encontrar o fim da tabela
    const fimMarcas = [
      "Orçamento sigiloso",
      "\n4. PRAZO",
      "\n4. ",
      "\n4 PRAZO",
    ];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 20);
      if (i >= 0 && i < fim) fim = i;
    }

    const corte = texto.slice(ini, fim);

    // 3. Split por início de item: \n<N>  <CATMAT7> -
    // Usamos split com lookahead para preservar o delimitador
    const blocos = corte.split(/\n(?=\d{1,3}\s+\d{7}\s+-\s+)/);

    const itens = [];
    for (const bloco of blocos) {
      const raw = bloco.trim();
      if (!raw) continue;

      // Extrair numero do item e remover cabeçalho "<N> <CATMAT> - "
      const mHead = raw.match(/^(\d{1,3})\s+\d{7}\s+-\s+([\s\S]*)/);
      if (!mHead) continue;

      const corpo = mHead[2];

      // Separar em linhas
      const linhas = corpo.split("\n");

      // Procurar a linha de unidade+quantidade
      let unidade = null;
      let quantidade = null;
      let unidLinhaIdx = -1;

      for (let i = 0; i < linhas.length; i++) {
        const t = linhas[i].trim();
        if (!t) continue;
        const m = t.match(RX_R_UNID_QTD);
        if (m) {
          unidade = m[1].trim();
          quantidade = Number(m[2].replace(/\./g, ""));
          unidLinhaIdx = i;
          break; // pega a primeira (e normalmente única) ocorrência
        }
      }

      // Fallback: itens curtos com tudo na mesma linha (desc + unid + qtd inline)
      // Ex: "Ácido muriático 1 litro  UND 140" ou "BUCHA P/ LOUÇA  Unid 100"
      if (quantidade == null) {
        const RX_R_INLINE = /^([\s\S]+?)\s{2,}(UNIDADES|UNIDADE|UND|FRASCOS|FRASCO|PACOTES|PACOTE|CAIXAS|CAIXA|Litros|Pares|Rolo|Und\.|Unid\.?|Conjunto|FARDOS|FARDO)\s+([\d.]+)\s*$/i;
        // Tenta na última linha não-vazia do bloco
        for (let i = linhas.length - 1; i >= 0; i--) {
          const t = linhas[i].trim();
          if (!t) continue;
          const m = t.match(RX_R_INLINE);
          if (m) {
            unidade = m[2].trim();
            quantidade = Number(m[3].replace(/\./g, ""));
            // Substituir a linha inteira pela parte da descrição (sem unid+qtd)
            linhas[i] = m[1].trim();
            unidLinhaIdx = -1; // não remover nenhuma linha inteira
          }
          break; // só tenta na última linha não-vazia
        }
      }

      if (quantidade == null) continue;

      // Descrição = tudo exceto a linha de unidade+qtd e linhas http/vazias
      const descLinhas = [];
      for (let i = 0; i < linhas.length; i++) {
        if (i === unidLinhaIdx) continue;
        const t = linhas[i].trim();
        if (!t) continue;
        if (/^https?:\/\//i.test(t)) continue; // link rodapé
        if (/^\s*$/.test(t)) continue;
        descLinhas.push(t);
      }
      const descricao = descLinhas.join(" ").replace(/\s+/g, " ").trim();

      if (!descricao || !quantidade) continue;
      itens.push({ quantidade, unidade, descricao });
    }
    return itens;
  },
};

// Layout S: "ITEM DESCRIÇÃO UNIDADE QUANTIDADE [VALOR UNITÁRIO VALOR TOTAL]"
// Tabela de TR/ETP de pregão eletrônico municipal (Bom Jardim de Minas - MG e similares).
// Itens numerados com 3 dígitos zero-padded (001, 002, ..., 095).
// Formato no TR (com preços):
//   001 ACIDO PERACÉTICO 30 LITROS. É UM
//   DESINFETANTE A BASE...
//   UNIDADE 24 1970.0860 47.282,06
// Formato no ETP seção 6 (sem preços — Tika serializa horizontal):
//   001 ACIDO PERACÉTICO 30 LITROS. É UM DESINFETANTE...
//   UNIDADE 24
// Unidades por extenso: UNIDADE, GALÃO, PACOTE, ROLO, EMBALAGEM, CAIXA.
// Quantidade: inteiro (sem separador de milhar neste layout).
// Rodapé de página intercalado: "Av. Dom Silvério, 170, Centro - Bom Jardim de Minas..."
// Fim da tabela: "R$ " (total geral) ou seção "3. DA ESTIMATIVA" / "7. Estimativa" / "3." / "7.".
// Caso visto: TR/ETP Bom Jardim de Minas-MG (7531978), 95 itens material de limpeza.
const RX_S_RODAPE = /Av\.\s*Dom\s+Silv[eé]rio[^\n]*Bom\s+Jardim\s+de\s+Minas[^\n]*\n[\s\S]*?licitacao@bomjardimdeminas\.mg\.gov\.br\s*\n?\s*\n?/g;
// Unidades válidas para este layout (por extenso, case-insensitive)
const UNID_S_VALIDAS = /^(UNIDADE|GALÃO|GALAO|PACOTE|ROLO|EMBALAGEM|CAIXA|FRASCO|METRO|PAR|PARES|LITRO|KIT|BOBINA)$/i;
// Regex para linha de fechamento: UNIDADE QTD [PRECO_UNIT PRECO_TOTAL]
// Preço unitário no TR: "1970.0860" (ponto decimal, 4 casas); preço total: "47.282,06" (vírgula decimal).
// No ETP seção 6: sem preços, só "UNIDADE QTD".
const RX_S_FECH = /^(UNIDADE|GALÃO|GALAO|PACOTE|ROLO|EMBALAGEM|CAIXA|FRASCO|METRO|PAR|PARES|LITRO|KIT|BOBINA)\s+(\d+)\s*(?:[\d.,]+\s+[\d.,]+)?\s*$/i;
const parserItemDescUnidQtdBJM = {
  id: "tr-item-desc-unid-qtd-bjm",
  detectar: (texto) =>
    /ITEM\s+DESCRI[ÇC][ÃA]O\s+UNIDADE\s+QUANTIDADE/.test(texto) &&
    /\n0{0,2}\d{1,3}\s+[A-ZÁÀÃÉÊÍÓÔÚÇ]/.test(texto),
  parsear: (texto) => {
    // Encontrar TODAS as tabelas com este cabeçalho (ETP pode ter 2: seção 6 + seção 7)
    const cabRx = /ITEM\s+DESCRI[ÇC][ÃA]O\s+UNIDADE\s+QUANTIDADE[^\n]*/g;
    let mCab;
    const tabelas = [];
    while ((mCab = cabRx.exec(texto)) !== null) {
      tabelas.push(mCab.index + mCab[0].length);
    }
    if (!tabelas.length) return [];

    // Tentar cada tabela e pegar a que retornar mais itens
    let melhorItens = [];

    for (let tIdx = 0; tIdx < tabelas.length; tIdx++) {
      const ini = tabelas[tIdx];
      // Fim: próximo cabeçalho OU marcas de seção
      const proxCab = tIdx + 1 < tabelas.length ? tabelas[tIdx + 1] - 80 : texto.length;
      const fimMarcas = [
        "\n3. DA ESTIMATIVA",
        "\n3. DA ESTIMAT",
        "\n7. Estimativa",
        "\n7. ESTIMATIVA",
        "\nR$ ",
      ];
      let fim = proxCab;
      for (const mk of fimMarcas) {
        const i = texto.indexOf(mk, ini);
        if (i >= 0 && i < fim) fim = i;
      }
      let corte = texto.slice(ini, fim);

      // Remover rodapés de página intercalados
      corte = corte.replace(RX_S_RODAPE, "\n");
      // Remover "mailto:" links injetados pelo Tika
      corte = corte.replace(/mailto:\S+/g, "");
      // Colapsar linhas vazias múltiplas
      corte = corte.replace(/\n{3,}/g, "\n\n").trim();

      // Split por início de item: 3 dígitos zero-padded (0NN) no início de linha
      // seguido de espaço + letra maiúscula. O zero-pad obrigatório evita que
      // números soltos na descrição ("15 L", "200 G", "500 ML") sejam falsos.
      // Para avisos com 100+ itens: segundo passo tenta (1\d{2}, 2\d{2}...).
      const blocos = corte.split(/\n(?=0\d{2}\s+[A-ZÁÀÃÉÊÍÓÔÚÇ])/);
      const itens = [];
      let ultimoNumProcessado = 0;

      for (const bloco of blocos) {
        const raw = bloco.trim();
        if (!raw) continue;

        // Extrair número: "001 TEXTO..." (3 dígitos zero-padded)
        const mNum = raw.match(/^(0\d{2})\s+([\s\S]*)/);
        if (!mNum) continue;
        const num = Number(mNum[1]);
        if (num < 1 || num > 999) continue;
        // Itens DEVEM crescer monotonicamente (evita falsos do meio da descrição)
        if (num <= ultimoNumProcessado) continue;

        const corpo = mNum[2];
        const linhas = corpo.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
        if (!linhas.length) continue;

        // Procurar de trás pra frente a linha de fechamento UNID QTD [PRECOS]
        let unidade = null;
        let quantidade = null;
        let fechIdx = -1;

        for (let i = linhas.length - 1; i >= 0; i--) {
          const m = linhas[i].match(RX_S_FECH);
          if (m) {
            unidade = m[1].toUpperCase();
            quantidade = Number(m[2]);
            fechIdx = i;
            break;
          }
          // Caso: UNID+QTD no FINAL de uma linha de descrição
          // ex: "DESIGN ANATÔMICO. TAMANHO MÉDIO. UNIDADE 30"
          const mFim = linhas[i].match(
            /^(.*?)\s+(UNIDADE|GALÃO|GALAO|PACOTE|ROLO|EMBALAGEM|CAIXA|FRASCO|METRO|PAR|PARES|LITRO|KIT|BOBINA)\s+(\d+)\s*(?:[\d.,]+\s+[\d.,]+)?\s*$/i,
          );
          if (mFim && mFim[1].trim().length > 2) {
            unidade = mFim[2].toUpperCase();
            quantidade = Number(mFim[3]);
            // Manter a parte antes da unidade como descrição
            linhas[i] = mFim[1].trim();
            fechIdx = i + 1; // descrição inclui esta linha (já limpa)
            break;
          }
        }

        if (quantidade == null || fechIdx < 0) continue;

        // Descrição: tudo antes da linha de fechamento
        const descLinhas = linhas.slice(0, fechIdx);
        const descricao = descLinhas.join(" ").replace(/\s+/g, " ").trim();
        if (!descricao) continue;

        itens.push({ quantidade, unidade, descricao });
      }

      if (itens.length > melhorItens.length) melhorItens = itens;
    }

    return melhorItens;
  },
};

// Layout T: "ITEM ESPECIFICAÇÃO UNIDADE QUANTIDADE"
// Tabela de Termo de Referência / ETP de pregão eletrônico SRP (Eirunepé-AM e similares).
// Itens numerados com 1-3 dígitos SEM zero-padding (1, 2, ..., 152).
// Formato multiline (maioria):
//   <N>
//   <descricao multilinhas com linhas vazias Tika entre elas>
//   <Unidade> <QTD>                -- ex: Caixa 650, Unidade 8.480
// Formato inline (itens curtos):
//   <N> <desc> <Unidade> <QTD>    -- ex: "25 Cartolina com 100 fls ... Pacote 220"
// Caso especial (quebra de página): unidade+qtd ANTES do rodapé e descrição
// CONTINUA após o rodapé. Nesse caso a descrição = antes + depois da unid+qtd.
// Unidades por extenso: Bloco, Caixa, Cartela, Estojo, Folha, Pacote, Rolo, Tubo, Unidade.
// Quantidade: inteiro com possível ponto de milhar (6.400, 8.480).
// Rodapé de página intercalado: "Estado do Amazonas\n...\nPREFEITURA MUNICIPAL DE EIRUNEPÉ\n..."
// Pode ter "Página N de N" adicional e "4 – ESPECIFICAÇÃO DO OBJETO" intercalado.
// Fim da tabela: seção pós-tabela (prazo de vigência, obrigações).
// Caso visto: PE 005/2026 SRP Eirunepé-AM (7532922), 152 itens material de expediente.
const RX_T_RODAPE = /Estado do Amazonas\s*\n[\s\S]*?PREG[ÃA]O ELETR[ÔO]NICO 005\/2026\s*-?\s*SRP\s*\n[\s\S]*?(?:Página \d+ de \d+\s*\n\s*\n?)?/g;
const RX_T_UNIDADES = /^(Bloco|Caixa|Cartela|Estojo|Folha|Pacote|Rolo|Tubo|Unidade)$/i;
const RX_T_UNID_QTD = /\b(Bloco|Caixa|Cartela|Estojo|Folha|Pacote|Rolo|Tubo|Unidade)\s+([\d.]+)\s*$/i;
const parserItemEspecUnidQtdEirunepe = {
  id: "item-espec-unid-qtd-eirunepe",
  detectar: (texto) =>
    /ITEM ESPECIFICAÇÃO UNIDADE QUANTIDADE/.test(texto) &&
    /EIRUNEP[ÉE]/i.test(texto),
  parsear: (texto) => {
    // Encontrar TODAS as tabelas (pode haver cópia no ETP) e pegar a melhor
    const cabRx = /ITEM ESPECIFICAÇÃO UNIDADE QUANTIDADE[^\n]*/g;
    let mCab;
    const tabelas = [];
    while ((mCab = cabRx.exec(texto)) !== null) {
      tabelas.push(mCab.index + mCab[0].length);
    }
    if (!tabelas.length) return [];

    let melhorItens = [];

    for (let tIdx = 0; tIdx < tabelas.length; tIdx++) {
      const ini = tabelas[tIdx];
      // Fim: próxima tabela OU marcas de seção pós-tabela
      const proxCab = tIdx + 1 < tabelas.length ? tabelas[tIdx + 1] - 100 : texto.length;
      const fimMarcas = [
        "\n1. O prazo de vigência",
        "\n1. O prazo de vig",
        "\n5 – PRAZO",
        "\n5 - PRAZO",
        "\nDas obrigações",
        "\nDAS OBRIGAÇÕES",
      ];
      let fim = proxCab;
      for (const mk of fimMarcas) {
        const i = texto.indexOf(mk, ini);
        if (i >= 0 && i < fim) fim = i;
      }
      let corte = texto.slice(ini, fim);

      // Remover rodapés de página intercalados
      corte = corte.replace(RX_T_RODAPE, "\n");
      // Remover "4 – ESPECIFICAÇÃO DO OBJETO" intercalado (cabeçalho de seção que aparece no meio)
      corte = corte.replace(/\d+\s*[–—-]\s*ESPECIFICA[ÇC][ÃA]O DO OBJETO\s*\n?/gi, "\n");
      // Colapsar linhas vazias múltiplas
      corte = corte.replace(/\n{3,}/g, "\n\n").trim();

      // Parse: split por início de item (número 1-3 dígitos no início de linha)
      // O número aparece como "<N> \n" (sozinho) ou "<N> <texto>" (inline).
      // Para evitar confundir números na descrição com itens, exigimos ordem crescente.
      const linhas = corte.split("\n");
      const itens = [];
      let ultimoNum = 0;
      let i = 0;

      while (i < linhas.length) {
        const l = linhas[i].trim();
        if (!l) { i++; continue; }

        // Tentar match de número de item no início da linha
        const mNum = l.match(/^(\d{1,3})\s+(.*)/);
        const mNumSo = l.match(/^(\d{1,3})\s*$/);
        let num = null;
        let restoInline = "";

        if (mNumSo) {
          num = Number(mNumSo[1]);
        } else if (mNum) {
          num = Number(mNum[1]);
          restoInline = mNum[2].trim();
        }

        // Validar: deve crescer monotonicamente e não ser absurdamente grande
        if (num == null || num <= ultimoNum || num > 999) { i++; continue; }

        // Verificar se é item TOTALMENTE inline: "<N> <desc> <Unid> <QTD>"
        if (restoInline) {
          const mInline = restoInline.match(
            /^(.*?)\s+(Bloco|Caixa|Cartela|Estojo|Folha|Pacote|Rolo|Tubo|Unidade)\s+([\d.]+)\s*$/i,
          );
          if (mInline && mInline[1].trim().length > 1) {
            // Item inteiro numa linha
            ultimoNum = num;
            itens.push({
              quantidade: Number(mInline[3].replace(/\./g, "")),
              unidade: mInline[2],
              descricao: mInline[1].replace(/\s+/g, " ").trim(),
            });
            i++;
            continue;
          }
        }

        // Coleta de bloco multiline: avançar e coletar todas as linhas do corpo
        const corpoLinhas = [];
        if (restoInline) corpoLinhas.push(restoInline);
        let j = i + 1;
        let unidade = null;
        let quantidade = null;
        let unidIdx = -1; // índice no corpoLinhas onde está a unid+qtd

        while (j < linhas.length) {
          const cl = linhas[j].trim();

          // Linha vazia: pular
          if (!cl) { j++; continue; }

          // Verificar se é o PRÓXIMO item (número sozinho ou inline)
          const mProxSo = cl.match(/^(\d{1,3})\s*$/);
          const mProxInline = cl.match(/^(\d{1,3})\s+\S/);
          if (mProxSo && Number(mProxSo[1]) > num) break;
          if (mProxInline && Number(mProxInline[1]) > num) {
            // Verificar se realmente é um item (tem unid+qtd inline ou é seguido de estrutura)
            const proxNum = Number(mProxInline[1]);
            if (proxNum === ultimoNum + 2 || proxNum === num + 1) break;
            // Senão pode ser número dentro da descrição
          }

          // Tentar detectar UNID+QTD
          // Caso A: linha INTEIRA é "Unidade 850"
          const mUQ = cl.match(/^(Bloco|Caixa|Cartela|Estojo|Folha|Pacote|Rolo|Tubo|Unidade)\s+([\d.]+)\s*$/i);
          if (mUQ) {
            unidade = mUQ[1];
            quantidade = Number(mUQ[2].replace(/\./g, ""));
            unidIdx = corpoLinhas.length; // marca posição ANTES de adicionar a unid+qtd
            j++;
            // IMPORTANTE: a descrição pode CONTINUAR após a unid+qtd (quebra de página)
            // Coletar linhas de continuação até o próximo item
            while (j < linhas.length) {
              const cl2 = linhas[j].trim();
              if (!cl2) { j++; continue; }
              const mProxSo2 = cl2.match(/^(\d{1,3})\s*$/);
              const mProxInline2 = cl2.match(/^(\d{1,3})\s+\S/);
              if (mProxSo2 && Number(mProxSo2[1]) > num) break;
              if (mProxInline2 && Number(mProxInline2[1]) > num) {
                const proxNum2 = Number(mProxInline2[1]);
                if (proxNum2 === num + 1) break;
              }
              // Verificar se é outra linha de unid+qtd (não deveria, mas por segurança)
              if (/^(Bloco|Caixa|Cartela|Estojo|Folha|Pacote|Rolo|Tubo|Unidade)\s+[\d.]+\s*$/i.test(cl2)) break;
              corpoLinhas.push(cl2);
              j++;
            }
            break;
          }

          // Caso B: UNID+QTD no FINAL de uma linha de texto
          // ex: "luz, ponta totalmente em fibra de poliéster em formato Estojo 425"
          const mFim = cl.match(/^(.*?)\s+(Bloco|Caixa|Cartela|Estojo|Folha|Pacote|Rolo|Tubo|Unidade)\s+([\d.]+)\s*$/i);
          if (mFim && mFim[1].trim().length > 1) {
            unidade = mFim[2];
            quantidade = Number(mFim[3].replace(/\./g, ""));
            // A parte antes da unidade é descrição
            corpoLinhas.push(mFim[1].trim());
            unidIdx = corpoLinhas.length; // após adicionar a desc parcial
            j++;
            // Coletar continuação após rodapé
            while (j < linhas.length) {
              const cl2 = linhas[j].trim();
              if (!cl2) { j++; continue; }
              const mProxSo2 = cl2.match(/^(\d{1,3})\s*$/);
              const mProxInline2 = cl2.match(/^(\d{1,3})\s+\S/);
              if (mProxSo2 && Number(mProxSo2[1]) > num) break;
              if (mProxInline2 && Number(mProxInline2[1]) > num) {
                const proxNum2 = Number(mProxInline2[1]);
                if (proxNum2 === num + 1) break;
              }
              if (/^(Bloco|Caixa|Cartela|Estojo|Folha|Pacote|Rolo|Tubo|Unidade)\s+[\d.]+\s*$/i.test(cl2)) break;
              corpoLinhas.push(cl2);
              j++;
            }
            break;
          }

          // Linha de descrição normal
          corpoLinhas.push(cl);
          j++;
        }

        if (quantidade != null) {
          const descricao = corpoLinhas.join(" ").replace(/\s+/g, " ").trim();
          if (descricao) {
            ultimoNum = num;
            itens.push({ quantidade, unidade, descricao });
          }
        }

        i = j;
      }

      if (itens.length > melhorItens.length) melhorItens = itens;
    }

    return melhorItens;
  },
};

// Layout U: "ITEM OBJETO UNIDADE QTDE VALOR MÁXIMO UNITÁRIO VALOR MÁXIMO TOTAL"
// Tabela de especificações do Termo de Referência (CONSAD).
// Formato principal (multiline):
//   <N>\n<desc multiline em MAIUSCULAS>\n\n<UNID>\n\n<QTD>\n\nR$ ...
//   Unidade e quantidade em linhas SEPARADAS por linhas vazias (Tika despeja colunas).
// Formato compacto (inline):
//   <N> <DESC> <UNID> <QTD> R$ ...
// Unidades: UN, PCT, CX, GL, FARDO, KG (siglas curtas, 1-5 chars).
// Quebra de pagina intercalada: "Página N de N" + ruido de espacos/linhas vazias.
//   No item 13 a descricao e CORTADA pela quebra de pagina e continua depois;
//   os precos (R$) do item aparecem ANTES da quebra (Tika despejou coluna de precos
//   antes do texto da linha seguinte) e a unidade+qtd ficam APOS a continuacao.
// Fim da tabela: "3.2 Tratando-se" ou secao pos-tabela.
// Caso visto: TR CONSAD São Miguel do Oeste-SC (7533163), 21 itens higiene/limpeza.
const RX_U_UNIDADES_SET = new Set([
  "un","und","pct","cx","gl","fardo","kg","fd","gal","galao","litro","lt",
  "metro","mt","resma","rolo","rl","frasco","tubo","pacote","pc",
]);
const parserItemObjetoUnidQtd = {
  id: "tr-item-objeto-unid-qtde",
  detectar: (texto) =>
    texto.includes("ITEM OBJETO UNIDADE QTDE") &&
    /VALOR\s+M[AÁ]XIMO/.test(texto),
  parsear: (texto) => {
    // 1. Recortar do cabecalho ate fim da tabela
    const cabIdx = texto.indexOf("ITEM OBJETO UNIDADE QTDE");
    if (cabIdx < 0) return [];
    const fimMarcas = [
      "3.2 Tratando-se",
      "3.2. Tratando-se",
      "4 DESCRIÇÃO DA SOLUÇÃO",
      "4. DESCRIÇÃO DA SOLUÇÃO",
      "\n4 DESCRIÇÃO",
      "\n4. DESCRIÇÃO",
    ];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, cabIdx + 30);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(cabIdx, fim);

    // 2. Remover ruido de quebra de pagina intercalada
    // "Página N de N" ate a proxima linha com conteudo util (letra maiuscula)
    corte = corte.replace(/P[aá]gina\s+\d+\s+de\s+\d+\s*\n[\s\n]*/gi, "\n");
    // Remover cabecalho da tabela (primeira ocorrencia e eventuais repeticoes pos-quebra)
    corte = corte.replace(/ITEM OBJETO UNIDADE QTDE[\s\S]*?TOTAL\s*/g, "\n");
    // Colapsar linhas vazias
    corte = corte.replace(/\n{3,}/g, "\n\n").trim();

    // 3. Estrategia de parse em 2 passos:
    //    Passo 1: localizar TODOS os inícios de item (numero no inicio da linha
    //             seguido de letra maiúscula na mesma linha ou na próxima).
    //    Passo 2: para cada bloco entre dois inícios consecutivos, extrair
    //             unidade+quantidade do FINAL do bloco (antes do R$).
    const lines = corte.split("\n");

    // Passo 1: detectar posicoes de inicio de item
    const starts = []; // [{lineIdx, num, descStart?}]
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      // Numero sozinho na linha
      const mNum = l.match(/^(\d{1,3})\s*$/);
      if (mNum) {
        const num = Number(mNum[1]);
        // Confirmar: proxima linha nao-vazia deve comecar com letra maiuscula (descricao)
        // ou ser inline com desc. Isso evita confundir quantidades (20, 15) com itens.
        let nextContent = null;
        for (let k = i + 1; k < lines.length && k < i + 5; k++) {
          const nl = lines[k].trim();
          if (nl) { nextContent = nl; break; }
        }
        if (nextContent && /^[A-ZÁÀÃÉÊÍÓÔÚÇ]/.test(nextContent) &&
            !RX_U_UNIDADES_SET.has(nextContent.toLowerCase()) &&
            !/^R\$/.test(nextContent)) {
          starts.push({ lineIdx: i, num, descStartLine: null });
        }
        continue;
      }
      // Numero + descricao na mesma linha: "5 DESORIZADOR..." ou "14 SACO DE LIXO..."
      const mNumDesc = l.match(/^(\d{1,3})\s+([A-ZÁÀÃÉÊÍÓÔÚÇ].*)/);
      if (mNumDesc) {
        const num = Number(mNumDesc[1]);
        starts.push({ lineIdx: i, num, descStartLine: mNumDesc[2] });
      }
    }

    // Filtrar: so aceitar starts com numero estritamente crescente (evita numeros
    // internos da descricao, quantidades soltas, etc.)
    const filtered = [];
    let ultimoNum = 0;
    for (const s of starts) {
      if (s.num > ultimoNum) {
        filtered.push(s);
        ultimoNum = s.num;
      }
    }

    // Passo 2: para cada item, extrair descricao + unidade + quantidade do bloco
    const itens = [];
    for (let idx = 0; idx < filtered.length; idx++) {
      const start = filtered[idx];
      const endLine = idx + 1 < filtered.length ? filtered[idx + 1].lineIdx : lines.length;

      // Coletar todas as linhas do bloco (entre start.lineIdx e endLine)
      const blocoLines = [];
      const firstLine = start.lineIdx;
      for (let i = firstLine + (start.descStartLine ? 0 : 1); i < endLine; i++) {
        blocoLines.push(lines[i]);
      }
      // Se a primeira linha tem descricao, substituir pelo texto sem o numero
      if (start.descStartLine && blocoLines.length > 0) {
        blocoLines[0] = start.descStartLine;
      }

      // Limpar: strip "R$ ..." de CADA linha (precos podem estar colados na mesma
      // linha da unidade+qtd no formato inline compacto do Tika) e remover linhas
      // que ficam vazias ou so com preco apos o strip.
      const limpo = blocoLines
        .map((l) => l.trim().replace(/\s*R\$\s*[\d.,]+/g, "").trim())
        .filter((l) => l && !/^\d+,\d{2}$/.test(l));

      // Encontrar unidade+quantidade de tras pra frente
      let unidade = null;
      let quantidade = null;
      let unidLinhaIdx = -1;

      for (let i = limpo.length - 1; i >= 0; i--) {
        const t = limpo[i];
        // Caso A: "UNID QTD" na mesma linha (ex: "GL 5", "PCT 40", "UN 30")
        const mUQ = t.match(/^([A-Za-z]{1,6})\s+(\d[\d.]*)\s*$/);
        if (mUQ && RX_U_UNIDADES_SET.has(mUQ[1].toLowerCase())) {
          unidade = mUQ[1].toUpperCase();
          quantidade = Number(mUQ[2].replace(/\./g, ""));
          unidLinhaIdx = i;
          break;
        }
        // Caso B: "...DESC UNID QTD" no final de linha (inline compacto)
        const mEmb = t.match(/^(.+?)\s+([A-Za-z]{1,6})\s+(\d[\d.]*)\s*$/);
        if (mEmb && RX_U_UNIDADES_SET.has(mEmb[2].toLowerCase())) {
          // Verificar que nao e descricao com numero casual no final
          // (confirmar: a parte antes da unidade tem ao menos 3 chars)
          if (mEmb[1].length >= 3) {
            unidade = mEmb[2].toUpperCase();
            quantidade = Number(mEmb[3].replace(/\./g, ""));
            limpo[i] = mEmb[1].trim(); // manter a parte de descricao
            unidLinhaIdx = i + 1; // descricao inclui esta linha (ja limpa)
            break;
          }
        }
        // Caso C: UNID sozinha na linha
        if (RX_U_UNIDADES_SET.has(t.toLowerCase()) && t.length <= 6) {
          unidade = t.toUpperCase();
          // QTD na proxima linha nao-vazia (apos esta)
          for (let k = i + 1; k < limpo.length; k++) {
            if (/^\d[\d.]*$/.test(limpo[k])) {
              quantidade = Number(limpo[k].replace(/\./g, ""));
              unidLinhaIdx = i;
              break;
            }
          }
          if (quantidade != null) break;
          unidade = null; // falhou, nao e unidade
        }
      }

      if (quantidade == null) continue;

      // Descricao: tudo antes da unidade
      const descSlice = unidLinhaIdx >= 0 ? limpo.slice(0, unidLinhaIdx) : limpo;
      const descricao = descSlice.join(" ").replace(/\s+/g, " ").trim();
      if (!descricao) continue;

      itens.push({ quantidade, descricao, ...(unidade ? { unidade } : {}) });
    }

    return itens;
  },
};

// Layout V: "Código Lote  Item Quant Und Especificação Valor Unitário"
// Modelo de Proposta de pregão eletrônico com código PAC, lote fixo, item sequencial,
// quantidade decimal (vírgula), unidade curta e descrição multiline.
// Cada item: "<cod_pac> <lote> <item_num> <qtd>,<dec> <UND> <desc...> <valor>"
// Descrição pode continuar em linhas subsequentes sem o padrão de início.
// Rodapé de página intercalado: "Município de Nova Ramada..." / "Avenida Gustavo Konig..."
// Fim da tabela: "Total Geral:" seguido do valor.
// Caso visto: PE 11/2026 Nova Ramada-RS (7534034), 142 itens.
const RX_V_RODAPE = /\n\s*\n\s*\n[\s\S]*?Munic[ií]pio de Nova Ramada[\s\S]*?licita@novaramada\.rs\.gov\.br\s*\n/g;
// Início de item: <cod_pac(1-5 dig)> <lote(1-2 dig)> <item_num(1-3 dig)> <qtd>,<dec> <UNID>
const RX_V_INICIO = /^(\d{1,5})\s+(\d{1,2})\s+(\d{1,3})\s+([\d.]+),(\d{2})\s+([A-Za-zÀ-ÿçÇ]{1,5})\s+(.+)$/;
const parserModeloPropostaCodLoteItem = {
  id: "proposta-cod-lote-item-qtd-und",
  detectar: (texto) =>
    /C[oó]digo\s+Lote\s+Item\s+Quant\s+Und\s+Especifica/i.test(texto),
  parsear: (texto) => {
    // Recortar do cabeçalho até "Total Geral:"
    const cabMatch = texto.match(/C[oó]digo\s+Lote\s+Item\s+Quant\s+Und\s+Especifica[^\n]*/i);
    if (!cabMatch) return [];
    const ini = cabMatch.index + cabMatch[0].length;
    const fimMarcas = ["Total Geral:", "TOTAL GERAL:", "RAZÃO SOCIAL"];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(ini, fim);

    // Remover rodapés de página intercalados
    corte = corte.replace(RX_V_RODAPE, "\n");
    // Remover cabeçalho "Máximo a ser Pago R$ Marca" que aparece após o cabeçalho principal
    corte = corte.replace(/M[aá]ximo\s+a\s+ser\s*\n\s*Pago\s+R\$\s*\n\s*Marca\s*\n/gi, "\n");
    // Colapsar linhas vazias
    corte = corte.replace(/\n{3,}/g, "\n\n");

    const itens = [];
    const linhas = corte.split("\n");
    let atual = null;

    for (const raw of linhas) {
      const linha = raw.trim();
      if (!linha) continue;

      const m = linha.match(RX_V_INICIO);
      if (m) {
        // Salvar item anterior se existir
        if (atual) itens.push(atual);
        const qtdInteira = m[4].replace(/\./g, "");
        const quantidade = Number(qtdInteira);
        const unidade = m[6].toUpperCase();
        // Descrição: resto da linha, removendo o valor unitário no final
        let descInicio = m[7]
          .replace(/\s+[\d.,]+\s*$/, "") // remove valor unitário no final
          .trim();
        atual = { quantidade, unidade, descricao: descInicio, extra: [] };
        continue;
      }

      // Linha de continuação: não é início de item
      if (atual) {
        // Remover valor unitário solto no final (ex: "120,48")
        const limpa = linha
          .replace(/^\s*[\d.,]+\s*$/, "") // linha só com número (preço) -> pular
          .trim();
        if (limpa) atual.extra.push(limpa);
      }
    }
    // Salvar último item
    if (atual) itens.push(atual);

    return itens.map((it) => ({
      quantidade: it.quantidade,
      unidade: it.unidade,
      descricao: [it.descricao, ...it.extra].join(" ").replace(/\s+/g, " ").trim(),
    }));
  },
};

// Layout W: "ITEM QTD UND DESCRIÇÃO" — Edital/Proposta de PE com multiplos LOTES.
// Cabeçalho "LOTE N – ..." seguido de "ITEM QTD UND DESCRIÇÃO" repete por lote.
// Itens vêm em DUAS variantes OCR misturadas:
//   INLINE:   "N QTD UND DESCRIÇÃO..." (tudo numa linha, desc pode continuar nas próximas)
//   EXPANDIDO: N / QTD / UND em linhas separadas (com linhas vazias entre elas),
//              depois a descrição multilinhas.
// Numeração reinicia a cada lote (1..N). O parser emite TODOS os lotes em sequência
// (ordem de leitura) para alinhar com a âncora portal (L1#1..L1#10, L2#11..L2#21, ...).
// Ruído intercalado: "PREFEITURA MUNICIPAL DE ... SÃO JOÃO DA PONTE - MG" (cabeçalho de página).
// Fim de cada tabela de lote: próximo "LOTE N –" OU seção pós-tabela ("Prazo de garantia",
// "CLÁUSULA", "Conforme exigência").
// Caso visto: PE 003/2025 São João da Ponte-MG (7534042), 46 itens em 4 lotes.
const RX_W_RODAPE = /\s*PREFEITURA MUNICIPAL DE\s*\n\s*SÃO JOÃO DA PONTE\s*-?\s*MG\s*\n/gi;
const parserEditalLoteItemQtdUnd = {
  id: "edital-lote-item-qtd-und",
  detectar: (texto) =>
    /ITEM\s+QTD\s+UND\s+DESCRI[ÇC][ÃA]O/.test(texto) &&
    /LOTE\s+\d+\s*[–\-]/.test(texto),
  parsear: (texto) => {
    // Encontrar TODAS as tabelas: cada "ITEM QTD UND DESCRIÇÃO" abre uma tabela de lote
    const cabRx = /ITEM\s+QTD\s+UND\s+DESCRI[ÇC][ÃA]O[^\n]*/g;
    const tabelas = [];
    let mCab;
    while ((mCab = cabRx.exec(texto)) !== null) {
      tabelas.push(mCab.index + mCab[0].length);
    }
    if (!tabelas.length) return [];

    // Marcas de fim de seção (pós todas as tabelas)
    const fimSecao = [
      "Prazo de garantia",
      "CLÁUSULA PRIMEIRA",
      "Conforme exigência legal",
      "DECLARO, sob as penas",
      "VALOR TOTAL ESTIMADO",
    ];

    const todosItens = [];

    for (let tIdx = 0; tIdx < tabelas.length; tIdx++) {
      const ini = tabelas[tIdx];
      // Fim da tabela: próximo cabeçalho de lote OU próxima tabela OU seção pós-tabela
      let fim = texto.length;
      // Próximo "LOTE N –"
      const proxLote = texto.slice(ini).match(/\nLOTE\s+\d+\s*[–\-]/);
      if (proxLote) {
        const posPL = ini + proxLote.index;
        if (posPL < fim) fim = posPL;
      }
      // Próximo cabeçalho de tabela (se houver mais tabelas)
      if (tIdx + 1 < tabelas.length) {
        // 80 chars antes do próximo cabeçalho (margem pro "ITEM QTD...")
        const proxCab = tabelas[tIdx + 1] - 80;
        if (proxCab > ini && proxCab < fim) fim = proxCab;
      }
      // Marcas de fim de seção
      for (const mk of fimSecao) {
        const posMk = texto.indexOf(mk, ini);
        if (posMk >= 0 && posMk < fim) fim = posMk;
      }

      let corte = texto.slice(ini, fim);
      // Remover cabeçalho de página intercalado
      corte = corte.replace(RX_W_RODAPE, "\n");
      // Colapsar linhas vazias
      corte = corte.replace(/\n{3,}/g, "\n\n");

      // Parsear os itens do lote
      const linhas = corte.split("\n");
      let i = 0;

      while (i < linhas.length) {
        const raw = linhas[i].trim();
        if (!raw) { i++; continue; }

        // TENTATIVA 1: item INLINE ou SEMI-INLINE — "N QTD UND [DESC...]"
        // QTD pode ter ponto separador de milhar e vírgula decimal (5.000 ou 10.000)
        // INLINE: desc na mesma linha ("2 5.000 UND CONDICIONADOR...")
        // SEMI-INLINE: desc na próxima linha ("9 5.000 UND\nSABONETE...")
        const mInline = raw.match(
          /^(\d{1,3})\s+([\d.]+(?:,\d+)?)\s+([A-Za-zÀ-ÿçÇ]{1,5})(?:\s+(.+))?$/
        );
        if (mInline) {
          const qtdStr = mInline[2].replace(/\./g, "").replace(/,.*/, "");
          const quantidade = Number(qtdStr);
          const unidade = mInline[3].toUpperCase();
          const descParts = mInline[4] ? [mInline[4].trim()] : [];

          // Coletar linhas de continuação da descrição
          let j = i + 1;
          while (j < linhas.length) {
            const prox = linhas[j].trim();
            if (!prox) { j++; continue; }
            // Parar se próxima linha é início de novo item (inline ou expandido)
            if (/^\d{1,3}\s+[\d.]+/.test(prox)) break;
            // Parar se é só um número (pode ser número de item expandido)
            if (/^\d{1,3}$/.test(prox)) break;
            // Parar se é marca de LOTE
            if (/^LOTE\s+\d+/i.test(prox)) break;
            // Parar se cabeçalho de tabela
            if (/^ITEM\s+QTD/i.test(prox)) break;
            // Linha de continuação
            descParts.push(prox);
            j++;
          }
          const descricao = descParts.join(" ").replace(/\s+/g, " ").trim();
          if (descricao && quantidade) {
            todosItens.push({ quantidade, unidade, descricao });
          }
          i = j;
          continue;
        }

        // TENTATIVA 2: item EXPANDIDO — número sozinho na linha
        const mNum = raw.match(/^(\d{1,3})$/);
        if (mNum) {
          // Avançar pulando linhas vazias para encontrar QTD
          let j = i + 1;
          let quantidade = null;
          let unidade = null;

          // Buscar QTD (próximo número)
          while (j < linhas.length) {
            const l = linhas[j].trim();
            if (l && /^[\d.]+(?:,\d+)?$/.test(l)) {
              const qtdStr = l.replace(/\./g, "").replace(/,.*/, "");
              quantidade = Number(qtdStr);
              j++;
              break;
            }
            if (l && !/^\s*$/.test(l)) break; // linha não-vazia que não é número -> abortar
            j++;
          }
          if (quantidade == null) { i++; continue; }

          // Buscar UND (próxima palavra curta — unidade de medida)
          while (j < linhas.length) {
            const l = linhas[j].trim();
            if (l && /^[A-Za-zÀ-ÿçÇ]{1,5}$/.test(l)) {
              unidade = l.toUpperCase();
              j++;
              break;
            }
            if (l && !/^\s*$/.test(l)) {
              // A unidade pode estar na mesma linha que o início da descrição
              // Ex: "UND" + "DESCRIÇÃO" nunca colam neste layout, mas checamos
              break;
            }
            j++;
          }
          if (!unidade) { i++; continue; }

          // Coletar linhas de descrição
          const descParts = [];
          while (j < linhas.length) {
            const l = linhas[j].trim();
            if (!l) { j++; continue; }
            // Parar se próximo item (inline ou número sozinho que poderia ser item)
            if (/^\d{1,3}$/.test(l)) break;
            if (/^\d{1,3}\s+[\d.]+/.test(l)) break;
            // Parar se LOTE ou cabeçalho
            if (/^LOTE\s+\d+/i.test(l)) break;
            if (/^ITEM\s+QTD/i.test(l)) break;
            // Parar em marcas de seção
            if (/^Prazo de garantia/i.test(l)) break;
            if (/^CLÁUSULA/i.test(l)) break;
            if (/^Conforme exigência/i.test(l)) break;
            if (/^VALOR TOTAL ESTIMADO/i.test(l)) break;
            descParts.push(l);
            j++;
          }
          const descricao = descParts.join(" ").replace(/\s+/g, " ").trim();
          if (descricao && quantidade) {
            todosItens.push({ quantidade, unidade, descricao });
          }
          i = j;
          continue;
        }

        i++;
      }
    }

    return todosItens;
  },
};

// Layout X: "ITEM DESCRIÇÃO QUANT. UND" — tabela de TR de pregão eletrônico com
// 4 colunas (ITEM | DESCRIÇÃO | QUANT. | UND). A coluna QUANT e UND podem ser
// intercaladas pelo Tika no MEIO da descrição (column interleaving do PDF).
// Cada item: número sozinho no início da linha + descrição multiline + "<qtd> UND"
// que pode estar no final OU intercalado no meio da descrição.
// Rodapé de página repetido: "ESTADO DO RIO GRANDE DO NORTE" +
// "PREFEITURA MUNICIPAL DE NÍSIA FLORESTA" + "Página X de Y" + endereço + email.
// Fim da tabela marcado por "1.2." (seção seguinte do TR).
// Caso visto: TR Nísia Floresta-RN (7535087), 86 itens equipamentos hospitalares.
const RX_X_RODAPE = /\s*(?:ESTADO DO RIO GRANDE DO NORTE|PREFEITURA MUNICIPAL DE NÍSIA FLORESTA|Página \d+ de \d+|Rua Prefeito Américo de Oliveira[^\n]*|E-mail: prefeitura@nisiafloresta\.rn\.gov\.br)\s*\n/g;
// Rodapé compacto: bloco inteiro do cabeçalho de página (linhas consecutivas de rodapé)
const RX_X_RODAPE_BLOCO = /(?:\n[ \t]*\n[ \t]*\n)?(?:ESTADO DO RIO GRANDE DO NORTE[\s\S]*?E-mail: prefeitura@nisiafloresta\.rn\.gov\.br[ \t]*\n)/g;
// Regex para capturar <qtd> UND(s) intercalado (linha isolada ou no final de linha)
const RX_X_QTD_UND = /^\s*(\d{1,4})\s+UND\s*$/gm;
const parserTRItemDescQuantUnd = {
  id: "tr-item-desc-quant-und-nf",
  detectar: (texto) =>
    texto.includes("ITEM DESCRIÇÃO QUANT. UND") &&
    texto.includes("PREFEITURA MUNICIPAL DE NÍSIA FLORESTA"),
  parsear: (texto) => {
    // 1. Recortar do cabeçalho da tabela até "1.2." (seção seguinte)
    const cabPos = texto.indexOf("ITEM DESCRIÇÃO QUANT. UND");
    if (cabPos < 0) return [];
    // Pular a linha do cabeçalho
    const iniCorte = texto.indexOf("\n", cabPos) + 1;
    const fimMarcas = ["\n1.2.", "\n1.2 "];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, iniCorte);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(iniCorte, fim);

    // 2. Remover rodapés de página (blocos inteiros)
    corte = corte.replace(RX_X_RODAPE_BLOCO, "\n");
    // Limpar linhas residuais de rodapé (caso o bloco não case por OCR leve)
    corte = corte.replace(RX_X_RODAPE, "\n");
    // Remover URLs soltas (http://www... do rodapé)
    corte = corte.replace(/http:\/\/www\.portaldecompraspublicas\.com\.br\/?\s*\n/g, "\n");
    // Colapsar linhas em branco múltiplas
    corte = corte.replace(/\n{3,}/g, "\n\n");

    // 3. Encontrar inícios de item: número (1-3 dígitos) no início da linha
    // seguido de espaço e texto (não "UND" sozinho).
    // PASSO A: coletar todos os candidatos
    const rxItemInicio = /^(\d{1,3}) +([A-ZÁÀÃÉÊÍÓÔÚÇ])/gm;
    const candidatos = [];
    let mItem;
    while ((mItem = rxItemInicio.exec(corte)) !== null) {
      const num = Number(mItem[1]);
      const restoDaLinha = corte.slice(mItem.index).split("\n")[0].trim();
      // Rejeitar linhas que são "<qtd> UND" ou "<qtd> UNIDADE"
      if (/^\d{1,4}\s+UND(?:S|\.?)?\s*$/i.test(restoDaLinha)) continue;
      if (/^\d{1,4}\s+UNIDADE/i.test(restoDaLinha)) continue;
      candidatos.push({ pos: mItem.index, num });
    }

    // PASSO B: filtrar falsos positivos. Um falso positivo é um candidato
    // cujo bloco NÃO contém "<qtd> UND". Estratégia:
    // 1. Montar blocos entre candidatos consecutivos
    // 2. Testar se o bloco contém "<qtd> UND" (isolado ou no final de linha)
    // 3. Se NÃO: é falso positivo, remover (bloco junta-se ao anterior)
    const rxTemQtdUnd = /\d{1,4}\s+UND\b/;
    const posicoes = [];
    for (let i = 0; i < candidatos.length; i++) {
      const ini2 = candidatos[i].pos;
      const fim2 = i + 1 < candidatos.length ? candidatos[i + 1].pos : corte.length;
      const bloco = corte.slice(ini2, fim2);
      if (rxTemQtdUnd.test(bloco)) {
        posicoes.push(candidatos[i].pos);
      }
      // Se não tem "<qtd> UND": falso positivo, será absorvido pelo bloco anterior
    }

    const itens = [];
    for (let p = 0; p < posicoes.length; p++) {
      const ini = posicoes[p];
      const fim2 = p + 1 < posicoes.length ? posicoes[p + 1] : corte.length;
      const bloco = corte.slice(ini, fim2).trim();
      if (!bloco) continue;

      // Extrair número do item
      const mNum = bloco.match(/^(\d{1,3})\s+([\s\S]*)/);
      if (!mNum) continue;
      const num = Number(mNum[1]);
      if (num < 1 || num > 999) continue;

      let corpo = mNum[2];

      // 4. Encontrar "<qtd> UND" no bloco. Pode estar:
      //    a) Numa linha isolada: "20 UND"
      //    b) No final de uma linha de descrição: "...INOX. 5 UND"
      //    c) Intercalado no meio da descrição (column interleaving do Tika)
      let quantidade = null;
      const qtdMatches = [];
      let mQtd;
      // Caso a) linha isolada: "^<qtd> UND$"
      const rxIsolado = /^[ \t]*(\d{1,4})\s+UND\s*$/gm;
      while ((mQtd = rxIsolado.exec(corpo)) !== null) {
        qtdMatches.push({ idx: mQtd.index, full: mQtd[0], qtd: Number(mQtd[1]), tipo: "isolado" });
      }
      // Caso b) no final da linha: "...texto <qtd> UND$"
      const rxFinal = /\s(\d{1,4})\s+UND\s*$/gm;
      while ((mQtd = rxFinal.exec(corpo)) !== null) {
        // Evitar duplicata com caso a (linha inteira já capturada)
        if (!qtdMatches.some((q) => q.idx <= mQtd.index && mQtd.index < q.idx + q.full.length)) {
          qtdMatches.push({ idx: mQtd.index, full: mQtd[0], qtd: Number(mQtd[1]), tipo: "final" });
        }
      }

      if (qtdMatches.length === 0) continue; // sem qtd/und legível
      // Usar a última match (geralmente a correta, posição final na coluna)
      const lastMatch = qtdMatches[qtdMatches.length - 1];
      quantidade = lastMatch.qtd;

      // 5. Remover TODAS as ocorrências de "<qtd> UND" do corpo para limpar a descrição
      // (tanto linhas isoladas quanto no final de linhas)
      let descricao = corpo
        .replace(/^[ \t]*\d{1,4}\s+UND\s*$/gm, "")  // linhas isoladas
        .replace(/\s+\d{1,4}\s+UND\s*$/gm, "")       // final de linha
        .replace(/\s+/g, " ")
        .trim();

      // Remover ponto de interrogação solto no final (artefato de OCR visto no item 78)
      descricao = descricao.replace(/\?\s*$/, "").trim();

      if (!descricao || !quantidade) continue;
      itens.push({ quantidade, descricao, unidade: "UND" });
    }
    return itens;
  },
};

// Layout Y: "Seq. Item Descrição/Especificação UN Quantidade Unitário"
// Tabela de itens de edital de pregão eletrônico (Portal de Compras Públicas).
// Formato Tika (colunas serializadas em linhas):
//   <seq_num>                     -- 1-3 digitos sozinho na linha
//   <item_code>                   -- 4+ digitos sozinho na linha (codigo do item)
//   <desc multiline>              -- descricao pode ter MUITAS linhas e rodape intercalado
//   <UNIDADE>                     -- sozinha na linha (UN, MÊS, etc.)
//   <qtd_com_decimais>            -- sozinha na linha (1.628.00, 12.00 — ponto decimal)
//   <preco_unitario>              -- sozinha na linha (161.67 — ponto decimal)
// Rodapé de página intercalado: bloco "PREFEITURA MUNICIPAL DE ELÓI MENDES /
//   Secretaria Municipal de Administração / Setor de Licitações" entre itens.
// Fim da tabela: "ANEXO II" ou "PROCESSO LICITATÓRIO" após o último item.
// Caso visto: Edital PE 21/2026 Elói Mendes-MG (7535113), 2 itens educação.
const RX_Y_RODAPE = /\s*PREFEITURA MUNICIPAL DE ELÓI MENDES\s*\n\s*Secretaria Municipal de Administra[çc][ãa]o\s*\n\s*Setor de Licita[çc][õo]es\s*\n/g;
// Unidades aceitas (extenso ou sigla) — case-insensitive
const RX_Y_UNIDADES = /^(UN|UND|UNID|UNIDADE|MÊS|MES|MENSAL|CX|PCT|KIT|SERVIÇO|SERVICO|HORA|HORAS)$/i;
const parserSeqItemDescUnQtdUnit = {
  id: "edital-seq-item-desc-un-qtd",
  detectar: (texto) =>
    /Seq\.\s+Item\s+Descri[çc][ãa]o\/Especifica[çc][ãa]o\s+UN\s+Quantidade\s+Unit[aá]rio/i.test(texto),
  parsear: (texto) => {
    // 1. Encontrar o cabeçalho da tabela
    const cabRx = /Seq\.\s+Item\s+Descri[çc][ãa]o\/Especifica[çc][ãa]o\s+UN\s+Quantidade\s+Unit[aá]rio/i;
    const cabMatch = texto.match(cabRx);
    if (!cabMatch) return [];
    const ini = cabMatch.index + cabMatch[0].length;

    // 2. Encontrar o fim da tabela
    const fimMarcas = [
      "ANEXO II",
      "PROCESSO LICITATÓRIO",
      "TERMO DE REFERÊNCIA",
    ];
    let fim = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, ini + 20);
      if (i >= 0 && i < fim) fim = i;
    }
    let corte = texto.slice(ini, fim);

    // 3. Remover rodapés de página intercalados
    corte = corte.replace(RX_Y_RODAPE, "\n");
    // Colapsar linhas vazias múltiplas
    corte = corte.replace(/\n{3,}/g, "\n\n").trim();

    // 4. Parse: encontrar blocos que começam com Seq (número sozinho na linha).
    //    Estrutura de cada item:
    //    <seq>\n\n<item_code>\n\n<desc...>\n\n<UNIDADE>\n\n<qtd>\n\n<preco>
    //    O item_code (4+ dígitos) distingue de números na descrição.
    const linhas = corte.split("\n").map((l) => l.trim());
    const itens = [];
    let idx = 0;

    while (idx < linhas.length) {
      const l = linhas[idx];
      if (!l) { idx++; continue; }

      // Detectar início de item: número (1-3 dígitos) sozinho na linha
      const mSeq = l.match(/^(\d{1,3})$/);
      if (!mSeq) { idx++; continue; }

      // Próxima linha não-vazia deve ser o código do item (4+ dígitos)
      let j = idx + 1;
      let itemCode = null;
      while (j < linhas.length) {
        if (linhas[j]) {
          if (/^\d{4,}$/.test(linhas[j])) {
            itemCode = linhas[j];
            j++;
          }
          break;
        }
        j++;
      }
      if (!itemCode) { idx++; continue; }

      // Coletar linhas de descrição até encontrar UNIDADE + QTD + PRECO no final
      const descParts = [];
      let unidade = null;
      let quantidade = null;

      while (j < linhas.length) {
        const cl = linhas[j];
        if (!cl) { j++; continue; }

        // Checar se é UNIDADE (sozinha na linha)
        if (RX_Y_UNIDADES.test(cl)) {
          // Confirmar: próxima linha não-vazia deve ser quantidade (número com decimais)
          let k = j + 1;
          let qtdStr = null;
          while (k < linhas.length) {
            if (linhas[k]) {
              if (/^[\d.]+$/.test(linhas[k])) {
                qtdStr = linhas[k];
              }
              break;
            }
            k++;
          }
          if (qtdStr) {
            unidade = cl.toUpperCase();
            // Quantidade: formato "1.628.00" (ponto separador de milhar + decimais)
            // ou "12.00" (sem milhar). Remover decimais ".00" e pontos de milhar.
            const qtdLimpo = qtdStr.replace(/\.00$/, "").replace(/\./g, "");
            quantidade = Number(qtdLimpo);
            break;
          }
        }

        // Checar se é o início de um novo item (número sozinho seguido de item_code)
        if (/^\d{1,3}$/.test(cl)) {
          // Olhar adiante: se a próxima linha não-vazia é item_code (4+ dígitos),
          // estamos no próximo item, parar sem consumir
          let k = j + 1;
          while (k < linhas.length && !linhas[k]) k++;
          if (k < linhas.length && /^\d{4,}$/.test(linhas[k])) break;
        }

        // Linha de descrição normal
        descParts.push(cl);
        j++;
      }

      if (quantidade != null) {
        const descricao = descParts.join(" ").replace(/\s+/g, " ").trim();
        if (descricao) {
          itens.push({ quantidade, descricao, ...(unidade ? { unidade } : {}) });
        }
      }

      idx = j + 1;
    }

    return itens;
  },
};

// Layout Z: Edital com tabela "ITEM DESCRIÇÃO UNID. QUANT. TOTAL" e colunas por secretaria.
// Cada item: numero em linha propria (ou inline), depois "(CÓD. N)" ou variantes
// ("CÓDIGO N", "CODIGO N", "COD.N", "(N)" sem prefixo), descricao multilinhas,
// depois UNIDADE QTD [sub-qtds por secretaria]. Unidade pode ficar na mesma linha
// que a qtd OU em linha propria com qtd na linha seguinte (Tika split de colunas).
// Descricao hifenizada pelo Tika ("DESCARTÁ-\nVEL"). Tabela pode aparecer 2x no
// doc (corpo do edital + TR anexo) — parse SO a primeira.
// Caso visto: Pouso Alegre-MG (7535119), 144 itens, 205 paginas.
const RX_Z_UNID = /(?:UNID(?:ADE|\.)?|GAL[ÃA]O|FRASCO|PACOTE|ROLO|CAIXA|CONJUNTO|POTE|KIT|TUBO|BALDE|METROS?|LITROS?|SACO|PAR|JOGO|FARDO|RESMA|BOBINA|REFIL|LATA|MA[ÇC]O|EMBALAGEM)\b/i;
const parserEditalItemDescUnidQtdTotal = {
  id: "edital-item-desc-unid-qtd-total",
  detectar: (texto) =>
    /ITEM\s+DESCRI[ÇC][ÃA]O\s+UNID\./.test(texto) &&
    /QUANT\.\s*\n?\s*TOTAL/.test(texto) &&
    /\(C[OÓ]D[IGOÓ]*\.?\s*\d{6,}\)/.test(texto),
  parsear: (texto) => {
    // 1. Localizar o cabecalho e delimitar a PRIMEIRA tabela
    const cabRx = /ITEM\s+DESCRI[ÇC][ÃA]O\s+UNID\./;
    const mCab = texto.match(cabRx);
    if (!mCab) return [];
    const cabPos = mCab.index;
    // Fim da tabela: "1.2. Para os itens" ou "1.2.Para os itens"
    const fimMarcas = ["1.2. Para os itens", "1.2.Para os itens"];
    let fimPos = texto.length;
    for (const mk of fimMarcas) {
      const i = texto.indexOf(mk, cabPos + 100);
      if (i > 0 && i < fimPos) fimPos = i;
    }

    let corte = texto.slice(cabPos, fimPos);

    // 2. Limpar ruido
    // Remover marcadores de pagina
    corte = corte.replace(/Página\s+\d+\s+de\s+\d+/g, "");
    // Juntar palavras hifenizadas pelo Tika (ex: "DESCARTÁ-\n\nVEL" -> "DESCARTÁVEL")
    corte = corte.replace(
      /([A-ZÁÀÃÉÊÍÓÔÚÇa-záàãéêíóôúç])-\s*\n\s*\n?\s*([A-ZÁÀÃÉÊÍÓÔÚÇa-záàãéêíóôúç])/g,
      "$1$2",
    );
    // Colapsar linhas vazias multiplas
    corte = corte.replace(/\n\s*\n\s*\n/g, "\n\n");

    // 3. Encontrar todos os inícios de item
    // Padrão: numero (1-3 digitos) seguido de espaco(s)/newline(s) e abertura de parêntese com código
    // Variantes: (CÓD. N), (CÓDIGO N), (CODIGO N), (COD.N), (N) sem prefixo
    const itemRx = /(?:^|\n)\s*(\d{1,3})\s+\((?:C[OÓ]D(?:IGO|\.)\s*)?(\d+)\)/g;
    const posicoes = [];
    let m;
    while ((m = itemRx.exec(corte))) {
      posicoes.push({ num: Number(m[1]), pos: m.index });
    }

    // Filtrar para sequencia estritamente crescente (evita numeros de dimensoes, ex: "113 X 37")
    let ultimoNum = 0;
    const filtradas = [];
    for (const p of posicoes) {
      if (p.num > ultimoNum) {
        filtradas.push(p);
        ultimoNum = p.num;
      }
    }

    // 4. Extrair descricao + unidade + quantidade de cada bloco
    const itens = [];
    for (let i = 0; i < filtradas.length; i++) {
      const cur = filtradas[i];
      const fimBloco = i < filtradas.length - 1 ? filtradas[i + 1].pos : corte.length;
      const bloco = corte.slice(cur.pos, fimBloco);
      const parenFim = bloco.indexOf(")");
      if (parenFim < 0) continue;
      const corpo = bloco.slice(parenFim + 1).trim();

      // Estrategia: procurar a ULTIMA ocorrencia de UNIDADE + QTD no corpo
      // (a unidade do item aparece apos a descricao; palavras como EMBALAGEM/UNIDADE
      // dentro da descricao sao falsos positivos anteriores)
      // Padrao A: UNIT QTD na mesma linha (ex: "FRASCO 2.500 0 2200 300 0")
      // Padrao B: UNIT numa linha, QTD na seguinte (ex: "EMBALAGEM \n3.000 0 ...")
      let unidade = null;
      let quantidade = null;
      let descFim = -1;

      // Tentar padrao A: UNIT seguida de numero na MESMA construcao (pode ter \n entre)
      // Procurar de tras pra frente para evitar falsos positivos no inicio da descricao
      const todosMatchesA = [];
      const rxA = new RegExp(
        "((?:UNID(?:ADE|\\.)?|GAL[ÃA]O|FRASCO|PACOTE|ROLO|CAIXA|CONJUNTO|POTE|KIT|TUBO|BALDE|METROS?" +
        "|LITROS?|SACO|PAR|JOGO|FARDO|RESMA|BOBINA|REFIL|LATA|MA[ÇC]O|EMBALAGEM))\\s*\\n?" +
        "\\s*([\\d.]+)\\s+(?:\\d[\\d.\\s]*\\d|\\d)\\s*(?:\\n|$)",
        "gi",
      );
      let mA;
      while ((mA = rxA.exec(corpo))) {
        todosMatchesA.push({ u: mA[1], q: mA[2], idx: mA.index, full: mA[0] });
      }
      if (todosMatchesA.length > 0) {
        // Usar o ULTIMO match (mais proximo do fim = mais provavel ser a linha de unidade real)
        const melhor = todosMatchesA[todosMatchesA.length - 1];
        unidade = melhor.u.replace(/\.$/, "");
        quantidade = Number(melhor.q.replace(/\./g, ""));
        descFim = melhor.idx;
      }

      if (quantidade == null || quantidade < 1) {
        // Tentar padrao simplificado: UNIT QTD no fim do corpo (sem sub-quantidades)
        const rxB = new RegExp(
          "((?:UNID(?:ADE|\\.)?|GAL[ÃA]O|FRASCO|PACOTE|ROLO|CAIXA|CONJUNTO|POTE|KIT|TUBO|BALDE|METROS?" +
          "|LITROS?|SACO|PAR|JOGO|FARDO|RESMA|BOBINA|REFIL|LATA|MA[ÇC]O|EMBALAGEM))\\s*\\n?" +
          "\\s*([\\d.]+)\\s*$",
          "im",
        );
        const mB = corpo.match(rxB);
        if (mB) {
          unidade = mB[1].replace(/\.$/, "");
          quantidade = Number(mB[2].replace(/\./g, ""));
          descFim = corpo.indexOf(mB[0]);
        }
      }

      if (quantidade == null || quantidade < 1) continue;

      // Descricao: tudo antes da posicao da unidade
      let descricao = corpo.slice(0, descFim).replace(/\s+/g, " ").trim();

      // Se ha texto APOS a linha de unidade+qtd (pagina cortou a descricao),
      // verificar se e continuacao de descricao
      if (todosMatchesA.length > 0) {
        const melhor = todosMatchesA[todosMatchesA.length - 1];
        const apos = corpo.slice(melhor.idx + melhor.full.length).trim();
        // Continuacao = texto que nao comeca com numero de item
        if (apos && !/^\d{1,3}\s+\(/.test(apos)) {
          const continuacao = apos.replace(/\s+/g, " ").trim();
          if (continuacao.length > 2) {
            descricao = descricao + " " + continuacao;
          }
        }
      }

      if (!descricao) continue;
      itens.push({ quantidade, unidade, descricao });
    }

    return itens;
  },
};

// Layout Z2: "CÓDIGO DISCRIMINAÇÃO UNIDADE QUANTIDADE" com precos na mesma linha
// Tabela multi-lote de edital/TR. Cabecalho repetido por pagina e por lote:
//   CÓDIGO DISCRIMINAÇÃO UNIDADE QUANTIDADE
//   PREÇO UNIT. PREÇO TOTAL
// Cada item: "<N> <descricao multiline>" seguido (possivelmente intercalado pela
// quebra de pagina do Tika) da linha de dados:
//   <UNIDADE_MAIUSCULA> <QTD> <PRECO_UNIT>,<CENTAVOS> <PRECO_TOTAL>,<CENTAVOS>
// A linha de dados pode cair NO MEIO da descricao (column interleaving do Tika).
// Lotes separados por "Total do Lote <valor>" + header de lote ("N - Nome do Lote").
// Fim da tabela: "TOTAL <valor>" global.
// Caso visto: PE 05/2026 Sao Jose dos Ramos-PB (7535136), 49 itens em 6 lotes.
const RX_Z2_DATA = /^([A-ZÁÀÂÃÉÊÍÓÔÚÇÜ]+)\s+(\d[\d.]*)\s+\d[\d.]*,\d{2}\s+\d[\d.]*,\d{2}\s*$/;
const parserCodigoDiscPreco = {
  id: "codigo-disc-unid-qtd-preco",
  detectar: (texto) =>
    /C[ÓO]DIGO\s+DISCRIMINA[ÇC][ÃA]O\s+UNIDADE\s+QUANTIDADE/.test(texto) &&
    // Diferencia do multiline sem preco: exige UNID_MAIUSCULA + QTD + 2 precos decimais
    texto.split(/\r?\n/).some((l) => RX_Z2_DATA.test(l.trim())),
  parsear: (texto) => {
    // 1. Recortar do primeiro cabecalho ate TOTAL global
    const cabRx = /C[ÓO]DIGO\s+DISCRIMINA[ÇC][ÃA]O\s+UNIDADE\s+QUANTIDADE/;
    const cabMatch = texto.match(cabRx);
    if (!cabMatch) return [];
    const cabPos = cabMatch.index;

    // Fim: "\s+TOTAL\s+<valor>" global (nao "Total do Lote")
    const fimRx = /\n\s+TOTAL\s+\d[\d.]*,\d{2}/;
    const fimMatch = texto.slice(cabPos).match(fimRx);
    const fimPos = fimMatch ? cabPos + fimMatch.index : texto.length;
    let corte = texto.slice(cabPos, fimPos);

    // 2. Limpar cabecalhos repetidos (pagina e lote)
    corte = corte.replace(
      /C[ÓO]DIGO\s+DISCRIMINA[ÇC][ÃA]O\s+UNIDADE\s+QUANTIDADE\s*\n(?:PRE[ÇC]O\s*\n\s*\n\s*UNIT\.\s*\n\s*\n\s*PRE[ÇC]O\s*\n\s*\n\s*TOTAL\s*\n|PRE[ÇC]O\s+UNIT\.\s+PRE[ÇC]O\s+TOTAL\s*\n)/gi,
      "\n",
    );
    // Remover ruido de quebra de pagina (linhas com so espacos)
    corte = corte.replace(/\n\s{3,}\n\s{3,}\n\s{3,}\n/g, "\n");
    corte = corte.replace(/\n  \n/g, "\n");

    // 3. Encontrar data lines e item starts
    const lines = corte.split("\n");
    const dataLineSet = new Set();
    const dataLines = [];
    const itemStarts = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      const md = t.match(RX_Z2_DATA);
      if (md) {
        dataLines.push({
          idx: i,
          unidade: md[1],
          quantidade: Number(md[2].replace(/\./g, "")),
        });
        dataLineSet.add(i);
        continue;
      }
      const mi = t.match(/^(\d{1,2})\s+[A-ZÁÀÂÃÉÊÍÓÔÚÇ]/);
      if (mi) {
        const num = Number(mi[1]);
        if (itemStarts.length === 0 || num > itemStarts[itemStarts.length - 1].num) {
          itemStarts.push({ idx: i, num });
        }
      }
    }

    // Precisamos de mesmo numero de item starts e data lines
    const n = Math.min(itemStarts.length, dataLines.length);
    if (n === 0) return [];

    // 4. Montar cada item
    const itens = [];
    for (let i = 0; i < n; i++) {
      const start = itemStarts[i].idx;
      const end = i < n - 1 ? itemStarts[i + 1].idx : lines.length;
      const descLines = [];
      for (let j = start; j < end; j++) {
        if (dataLineSet.has(j)) continue;
        const t = lines[j].trim();
        if (!t) continue;
        // Pular headers de lote ("2 - Materiais de Limpeza...")
        if (/^\d+\s*-\s+[A-ZÁÀÂÃÉÊÍÓÔÚÇ]/.test(t) && t.length < 80) continue;
        // Pular "Total do Lote"
        if (/^Total do Lote/i.test(t)) continue;
        descLines.push(t);
      }
      if (!descLines.length) continue;
      // Remover numero do item da primeira linha
      descLines[0] = descLines[0].replace(/^\d{1,2}\s+/, "");
      const descricao = descLines.join(" ").replace(/\s+/g, " ").trim();
      if (!descricao) continue;
      itens.push({
        quantidade: dataLines[i].quantidade,
        unidade: dataLines[i].unidade,
        descricao,
      });
    }
    return itens;
  },
};

// Layout Z: "CÓDIGO DISCRIMINAÇÃO UNIDADE QUANTIDADE PREÇO UNIT. PREÇO TOTAL"
// Tabela de TR/Edital com cabecalho "CÓDIGO DISCRIMINAÇÃO" (por extenso, com acento).
// Itens multiline: numero (1-2 dig) + descricao em varias linhas, depois uma linha
// separada com "Unidade Qtd [Preco_unit Preco_total]" (ex: "Und 8800 20,65 181.720,00").
// O documento pode conter DUAS tabelas identicas (TR + modelo de proposta);
// o parser le a PRIMEIRA que tenha precos preenchidos.
// Quebras de pagina intercalam a descricao — limpas antes do parse.
// Caso visto: PE 016/2026 Mamanguape-PB (7535134), 4 itens alimentacao.
const parserCodigoDiscriminacaoMultiline = {
  id: "codigo-discriminacao-multiline",
  detectar: (texto) =>
    // "CÓDIGO" por extenso (nao "CÓD." abreviado) + DISCRIMINAÇÃO + UNIDADE + QUANTIDADE
    /C[ÓO]DIGO\s+DISCRIMINA[ÇC][ÃA]O\s+UNIDADE\s+QUANTIDADE/.test(texto) &&
    // Linha de unidade+qtd separada (multiline, nao inline como servico)
    /\n\s*(?:Und|Kit|Un|Pct|Cx|Rl|Pote|Frasco|Metro|Litro|Saco|Par|Jogo|Fardo|Resma)\s+\d/i.test(texto),
  parsear: (texto) => {
    // 1. Localizar o PRIMEIRO cabecalho
    const cabRx = /C[ÓO]DIGO\s+DISCRIMINA[ÇC][ÃA]O\s+UNIDADE\s+QUANTIDADE/;
    const cabMatch = texto.match(cabRx);
    if (!cabMatch) return [];
    const cabPos = cabMatch.index + cabMatch[0].length;

    // 2. Delimitar fim da tabela: " TOTAL xxx.xxx,xx" (valor com virgula decimal),
    //    ou secao "3.0." / "Etc.". Offset minimo de 200 chars para nao casar com
    //    "PREÇO TOTAL" do cabecalho.
    const MIN_OFFSET = 200;
    const buscaFim = texto.slice(cabPos + MIN_OFFSET);
    const fimMarcas = [/\bTOTAL\s+[\d.]+,\d{2}/, /\n\s*3\.0\./, /\nEtc\./];
    let fimPos = texto.length;
    for (const rx of fimMarcas) {
      const m = buscaFim.match(rx);
      if (m) {
        const pos = cabPos + MIN_OFFSET + m.index;
        if (pos < fimPos) fimPos = pos;
      }
    }
    let corte = texto.slice(cabPos, fimPos);

    // 3. Limpar ruido: cabecalhos de pagina e linhas em branco multiplas
    corte = corte.replace(/\n\s*\n\s*\n/g, "\n\n");

    // 4. Identificar linhas de unidade+quantidade (delimitadores de item)
    // Padrao: "Und 8800 20,65 181.720,00" ou "Kit 6000" (modelo proposta sem precos)
    const rxUnidQtd = /^\s*(Und|Kit|Un|Pct|Cx|Rl|Pote|Frasco|Metro|Litro|Saco|Par|Jogo|Fardo|Resma|Unidade|Caixa|Pacote|Rolo)\s+(\d[\d.]*)\b/im;

    // 5. Encontrar inicio de cada item: linha comecando com numero (1-2 dig) + espaco + letra maiuscula
    const linhas = corte.split("\n");
    const posicoes = []; // { idx: indice da linha, num: numero do item }
    for (let i = 0; i < linhas.length; i++) {
      const m = linhas[i].match(/^\s*(\d{1,2})\s+[A-ZÁÀÂÃÉÊÍÓÔÚÇ]/);
      if (m) {
        const num = Number(m[1]);
        // Deve ser crescente (evitar falsos positivos dentro da descricao)
        if (posicoes.length === 0 || num > posicoes[posicoes.length - 1].num) {
          posicoes.push({ idx: i, num });
        }
      }
    }

    // 6. Extrair cada item
    const itens = [];
    for (let p = 0; p < posicoes.length; p++) {
      const inicio = posicoes[p].idx;
      const fimItem = p < posicoes.length - 1 ? posicoes[p + 1].idx : linhas.length;
      const bloco = linhas.slice(inicio, fimItem);

      // Procurar a linha de unidade+qtd neste bloco
      let quantidade = null;
      let unidade = null;
      let unidLinhaIdx = -1;
      for (let j = 1; j < bloco.length; j++) {
        const mu = bloco[j].match(rxUnidQtd);
        if (mu) {
          unidade = mu[1];
          quantidade = Number(mu[2].replace(/\./g, ""));
          unidLinhaIdx = j;
          break;
        }
      }
      if (quantidade == null || quantidade < 1) continue;

      // Descricao: linhas do inicio ate a linha de unidade (exclusive)
      // A primeira linha comeca com "N TEXTO" — remover o numero
      const descLinhas = bloco.slice(0, unidLinhaIdx);
      descLinhas[0] = descLinhas[0].replace(/^\s*\d{1,2}\s+/, "");
      const descricao = descLinhas
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (!descricao) continue;
      itens.push({ quantidade, unidade, descricao });
    }

    return itens;
  },
};

const REGISTRY = [parserItemQtdUnid, parserPedidoLinha, parserTRBomPrincipio, parserLimaduarteTR, parserETPCatmatUnidQtd, parserPEItemNomeUnidQtd, parserCodDiscriminacao, parserTREspecTecnica, parserIPMCatmatDescUndQtd, parserTREspecCatmatQtdUnidade, parserCodDiscriminacaoServico, parserTRItemEspecUnidQuant, parserPropostaPrecos, parserDFDAbase, parserEditalAnexoParticip, parserCodigoDescItemUnidQtd, parserTRLoteItemIvoti, parserTRCatmat7DescUnidQtd, parserItemDescUnidQtdBJM, parserItemEspecUnidQtdEirunepe, parserItemObjetoUnidQtd, parserModeloPropostaCodLoteItem, parserEditalLoteItemQtdUnd, parserTRItemDescQuantUnd, parserSeqItemDescUnQtdUnit, parserEditalItemDescUnidQtdTotal, parserCodigoDiscPreco, parserCodigoDiscriminacaoMultiline];

// --- ancora do portal -------------------------------------------------------
async function carregarAncora(c, effectiId) {
  const { rows } = await c.query(
    `SELECT (item_numero)::int AS numero, lote, unidade, quantidade, descricao
       FROM public.aviso_itens_portal
      WHERE effecti_id = $1
      ORDER BY (item_numero)::int`,
    [effectiId],
  );
  return rows.map((r) => ({
    numero: Number(r.numero),
    lote: r.lote,
    unidade: r.unidade,
    quantidade: Number(r.quantidade), // numeric -> string no pg
    descricao: r.descricao,
  }));
}

// --- gate: reconcilia o parse com a ancora por sequencia --------------------
// Retorna { modo, sinais }:
//   modo 'tecnica' -> descricao do doc confiavel (qtdes casam ou so divergem por
//                     EMBALAGEM); embalagem[] marca posicoes onde vale o edital.
//   modo 'portal'  -> parser nao confiavel (comprimento difere OU qtde difere
//                     com a MESMA unidade); cai na descricao do portal.
function alinhar(ancora, parsed) {
  if (parsed.length !== ancora.length) {
    return { modo: "portal", motivo: `comprimento difere (portal ${ancora.length} x parse ${parsed.length})` };
  }
  const embalagem = [];
  const erro = [];
  for (let i = 0; i < ancora.length; i++) {
    if (Number(ancora[i].quantidade) === Number(parsed[i].quantidade)) continue;
    const uDoc = parsed[i].unidade;
    if (uDoc != null && normalizarUnidade(uDoc) !== normalizarUnidade(ancora[i].unidade)) {
      embalagem.push(i); // unidade difere = embalagem esperada (vale o edital)
    } else {
      erro.push(i); // mesma unidade + qtde difere = parser furou
    }
  }
  if (erro.length) {
    return { modo: "portal", motivo: `${erro.length} pos com qtde divergente (mesma unidade)`, embalagem, erro };
  }
  return { modo: "tecnica", embalagem };
}

// --- monta a lista final (sempre ancora.length itens) -----------------------
function montarItens(ancora, parsed, align) {
  return ancora.map((a, i) => {
    if (align.modo === "portal") {
      return {
        item_numero: String(a.numero), lote: a.lote, unidade: a.unidade,
        quantidade: a.quantidade, descricao: a.descricao,
        fonte_descricao: "portal", ordem: i + 1,
      };
    }
    const p = parsed[i];
    const ehEmbalagem = align.embalagem?.includes(i);
    return {
      item_numero: String(a.numero),
      lote: a.lote,
      unidade: ehEmbalagem && p.unidade ? p.unidade : a.unidade,
      quantidade: ehEmbalagem ? p.quantidade : a.quantidade,
      descricao: p.descricao,
      fonte_descricao: "tecnica",
      ordem: i + 1,
    };
  });
}

// --- grava 1 documento (delete + insert atomico, status extraido) -----------
async function gravarDoc(c, doc, itens) {
  await c.query("BEGIN");
  try {
    await c.query("DELETE FROM public.documento_itens WHERE documento_id=$1", [doc.id]);
    for (const it of itens) {
      await c.query(
        `INSERT INTO public.documento_itens
           (documento_id, lista_origem, fonte_descricao, item_numero, lote,
            descricao, unidade, quantidade, ordem, item_estado, item_origem)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'revisado','deterministico')`,
        [doc.id, doc.nome_arquivo, it.fonte_descricao, it.item_numero, it.lote,
         it.descricao, it.unidade, it.quantidade, it.ordem],
      );
    }
    await c.query(
      `UPDATE public.documentos
          SET itens_status='extraido', itens_tentativas=0, itens_extraido_em=now()
        WHERE id=$1`,
      [doc.id],
    );
    await c.query("COMMIT");
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* sem tx aberta */ }
    throw e;
  }
}

// --- main -------------------------------------------------------------------
async function main() {
  const env = loadEnv();
  const url = env.SUPABASE_DB_URL || env.DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DB_URL ausente no .env.local");
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const ancora = await carregarAncora(c, EFFECTI_ID);
    if (!ancora.length) {
      console.error(`Aviso ${EFFECTI_ID}: sem ancora no portal (aviso_itens_portal vazio). Colete a Lista Effecti antes.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Aviso ${EFFECTI_ID} | ancora portal: ${ancora.length} itens${DRY ? " | modo DRY" : ""}`);

    const { rows: docs } = await c.query(
      `SELECT d.id, d.nome_arquivo, d.itens_status
         FROM public.documento_vinculos dv
         JOIN public.documentos d ON d.id = dv.documento_id
        WHERE dv.fonte='effecti' AND dv.registro_origem_id=$1
          ${SO_DOC ? "AND d.id=$2" : ""}
        ORDER BY d.nome_arquivo`,
      SO_DOC ? [EFFECTI_ID, SO_DOC] : [EFFECTI_ID],
    );

    const cobertos = [];
    const semParser = [];
    for (const doc of docs) {
      const { rows: tr } = await c.query("SELECT texto FROM public.documentos WHERE id=$1", [doc.id]);
      const texto = tr[0]?.texto;
      if (!texto || !texto.trim()) { console.log(`- ${doc.nome_arquivo}: sem texto, pula`); continue; }

      const parser = REGISTRY.find((p) => p.detectar(texto));
      if (!parser) { semParser.push(doc); console.log(`- ${doc.nome_arquivo}: SEM PARSER (layout novo)`); continue; }

      const parsed = parser.parsear(texto);
      const align = alinhar(ancora, parsed);
      const itens = montarItens(ancora, parsed, align);
      const tag = align.modo === "tecnica"
        ? `tecnica${align.embalagem?.length ? ` (+${align.embalagem.length} embalagem)` : ""}`
        : `portal (${align.motivo})`;
      console.log(`- ${doc.nome_arquivo}: parser=${parser.id} parse=${parsed.length} -> ${tag}`);

      if (!DRY) { await gravarDoc(c, doc, itens); cobertos.push(doc.nome_arquivo); }
    }

    console.log("\n--- resumo ---");
    console.log(`docs com parser: ${docs.length - semParser.length}/${docs.length}`);
    if (semParser.length) console.log(`SEM parser (treinar): ${semParser.map((d) => d.nome_arquivo).join(" | ")}`);
    if (!DRY) console.log(`gravados (extraido): ${cobertos.length ? cobertos.join(" | ") : "nenhum"}`);
    else console.log("DRY: nada gravado.");
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
