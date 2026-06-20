// =====================================================================
// _shared/normalizar.ts
// Normalizacao de descricao para CRUZAMENTO TOLERANTE entre o item do edital
// e o item destacado pelo Effecti (e, na fidelidade/recall, entre listas).
//
// PORTE (B4): `normDesc` nasceu DENTRO da Edge `automacao-aviso-itens`
// (badge Effecti no cockpit). O validador de recall do Effecti
// (`v1-triagem-veredito`) precisa da MESMA chave de cruzamento; como uma Edge
// Deno nao importa o interno de outra Edge, a funcao foi extraida para ca e as
// duas pontas (cockpit + veredito) passam a importar daqui. Comportamento
// preservado bit-a-bit (lower + remove diacriticos + so [a-z0-9] + prefixo 30).
// =====================================================================

/**
 * Normaliza descricao para cruzamento tolerante (acento/caixa/pontuacao):
 * lower + remove diacriticos + so [a-z0-9] (remove espacos e tudo nao
 * alfanumerico) + prefixo de 30 chars. Mesma chave dos dois lados do
 * cruzamento (Effecti x documento_itens).
 */
export function normDesc(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 30);
}
