// =====================================================================
// Strip de HTML para texto limpo (Deno / Edge Functions).
//
// Contexto: nomus_processos.descricao e HTML (`<p style=...>`, entidades
// `&quot;`, `&ocirc;`). Antes de chunkar/embeddar precisamos do texto puro
// (parity com o chunk=texto dos documentos). O runner Node (extrator.mjs)
// tem um stripTags equivalente, mas ele NAO roda no Edge — este e o ponto
// unico de strip server-side. Decodifica entidades nomeadas comuns +
// numericas (&#234; / &#xEA;), remove script/style/tags e colapsa espaco.
// =====================================================================

const ENTIDADES_NOMEADAS: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  copy: "\u00a9",
  reg: "\u00ae",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  laquo: "\u00ab",
  raquo: "\u00bb",
  deg: "\u00b0",
  ordm: "\u00ba",
  ordf: "\u00aa",
  euro: "\u20ac",
};

/** Decodifica entidades HTML numericas (&#234; / &#xEA;) e nomeadas comuns. */
function decodeEntidades(texto: string): string {
  return texto.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, corpo: string) => {
    if (corpo[0] === "#") {
      const ehHex = corpo[1] === "x" || corpo[1] === "X";
      const codigo = parseInt(ehHex ? corpo.slice(2) : corpo.slice(1), ehHex ? 16 : 10);
      if (Number.isNaN(codigo) || codigo <= 0 || codigo > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codigo);
      } catch {
        return match;
      }
    }
    const nomeada = ENTIDADES_NOMEADAS[corpo.toLowerCase()];
    return nomeada ?? match;
  });
}

/**
 * Remove HTML e devolve texto puro: tira script/style, remove tags,
 * decodifica entidades, colapsa whitespace. Idempotente sobre texto ja limpo.
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  const semTags = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntidades(semTags).replace(/\s+/g, " ").trim();
}
