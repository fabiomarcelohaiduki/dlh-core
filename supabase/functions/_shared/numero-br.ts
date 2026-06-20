// =====================================================================
// _shared/numero-br.ts
// Numeros no formato pt-BR: parsing e geracao de variantes literais.
//
// PORTE (B4): `parseNumeroBr` nasceu no script Node `.github/scripts/
// extrair-itens.mjs` (parser DOCX, runtime Node). A trava de FIDELIDADE da Edge
// `v1-documento-itens-gravar` (runtime Deno) precisa da MESMA semantica de
// numero, e um .mjs de Actions NAO e importavel numa Edge Deno (runtimes
// distintos — B4: "nao importar direto entre runtimes"). Por isso a copia vive
// aqui, em Deno. As duas implementacoes sao gemeas DE PROPOSITO; manter em
// sincronia se a regra de parsing mudar.
//
// O grep reverso (fidelidade) NAO parseia o verbatim — ele procura a OCORRENCIA
// LITERAL do numero do item dentro do texto-fonte. Como o mesmo valor pode estar
// escrito de varias formas em pt-BR (12.345,67 / 12345,67 / 12345.67 / 12345),
// `numeroVariantesBr` gera o conjunto de grafias a procurar. Achar QUALQUER uma
// confirma a fidelidade daquele numero.
// =====================================================================

/**
 * Numero pt-BR -> Number. "3.196,00"->3196, "7,99"->7.99, "4"->4. null se vazio.
 * Gemea de parseNumeroBr em .github/scripts/extrair-itens.mjs (runtime Node).
 */
export function parseNumeroBr(s: string | number | null | undefined): number | null {
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

/** Agrupa a parte inteira em milhares com ponto: "12345" -> "12.345". */
function agruparMilhar(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * Gera as grafias literais pt-BR (e a forma com ponto decimal) de um numero,
 * para o GREP REVERSO da fidelidade. Achar qualquer variante no verbatim
 * confirma o numero. Ex.: 12345.67 -> {"12.345,67","12345,67","12345.67"};
 * 3196 -> {"3196","3.196","3196,00","3.196,00"}.
 *
 * So gera variantes para numeros finitos e nao-negativos (qtd/preco). Numeros
 * com mais de 2 casas decimais sao arredondados para 2 (precos/qtds reais).
 */
export function numeroVariantesBr(n: number): string[] {
  if (!Number.isFinite(n) || n < 0) return [];
  const variantes = new Set<string>();

  const ehInteiro = Number.isInteger(n);
  const intStr = String(Math.trunc(n));
  const intAgrupado = agruparMilhar(intStr);

  // Forma com 2 casas (preco / valor com centavos), virgula e ponto decimal.
  const doisDec = n.toFixed(2); // "12345.67" (ponto decimal, sem milhar)
  const [parteInt2, parteDec2] = doisDec.split(".");
  const int2Agrupado = agruparMilhar(parteInt2);
  variantes.add(`${parteInt2},${parteDec2}`); // 12345,67
  variantes.add(`${int2Agrupado},${parteDec2}`); // 12.345,67
  variantes.add(doisDec); // 12345.67 (ponto decimal)
  variantes.add(`${int2Agrupado}.${parteDec2}`); // 12.345.67 (raro, mas tolera)

  if (ehInteiro) {
    variantes.add(intStr); // 3196
    variantes.add(intAgrupado); // 3.196
  } else {
    // Decimal com mais/menos casas: tambem a grafia "crua" (1 a 4 casas).
    const cru = String(n);
    if (cru.includes(".")) {
      const [pi, pd] = cru.split(".");
      variantes.add(`${pi},${pd}`);
      variantes.add(`${agruparMilhar(pi)},${pd}`);
      variantes.add(cru);
    }
  }

  // Defesa: nunca devolver a string vazia como agulha (casaria em todo lugar).
  variantes.delete("");
  return [...variantes];
}
