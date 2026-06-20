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

/**
 * Mapeia o MOTIVO de uma suspeita de fidelidade (texto gerado pelo servidor em
 * v1-documento-itens-gravar/validarFidelidade) para a COLUNA numerica de
 * documento_itens que a correcao humana (numero_corrigido) deve ajustar. Os
 * prefixos sao deterministicos: "preco ... ausente" / "quantidade ... ausente".
 * Soma divergente nao aponta uma coluna unica (qtd/unitario/total) -> null.
 * Manter em sincronia com os motivos gerados em validarFidelidade.
 */
export function colunaSuspeitaDoMotivo(
  motivo: string | null | undefined,
): "preco_referencia" | "quantidade" | null {
  const m = (motivo ?? "").toLowerCase();
  if (m.includes("preco")) return "preco_referencia";
  if (m.includes("quantidade")) return "quantidade";
  return null;
}
