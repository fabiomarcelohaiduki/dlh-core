// =====================================================================
// _shared/ocr-confianca.ts
// PORTAO DE QUALIDADE do OCR (Sprint 4, decisao 7): estima a confianca do texto
// produzido por OCR a partir do PROPRIO texto (Tika nao devolve confianca do
// motor de forma confiavel). Heuristica barata e PURA (sem IO):
//   - razao de caracteres "esperados" num edital pt-BR (letras com acento,
//     digitos, espacos, pontuacao/simbolos comuns) sobre o total. OCR ruim
//     enche o texto de simbolos/ruido/caractere de substituicao -> razao cai.
//   - piso de tamanho: OCR que rendeu quase nada e suspeito.
// Abaixo do limiar -> baixa confianca -> rotear ao humano; a fidelidade NAO
// confia no grep reverso desse documento (o numero pode existir, porem corrompido).
//
// E uma TRIAGEM (decisao final e humana), nao um veredito: prefere falso-positivo
// (mandar bom para revisao) a falso-negativo (confiar em lixo). Constantes
// ajustaveis abaixo.
// =====================================================================

/** Razao minima de caracteres esperados para o OCR ser confiavel. */
const LIMIAR_CONFIANCA = 0.85;
/** Piso de caracteres nao-espaco: abaixo disso o OCR rendeu pouco demais. */
const MIN_CHARS_NAO_ESPACO = 120;

/**
 * Caracteres ESPERADOS num edital pt-BR: letras de qualquer idioma (com acento),
 * digitos, espacos e pontuacao/simbolos comuns de texto legal/tabela. O resto
 * (caractere de substituicao, blocos, ruido) conta como "inesperado".
 */
const ESPERADOS = /[\p{L}\p{N}\s.,;:!?()[\]{}/%§°ºª$@#&*+=_'"–—-]/gu;

export interface ConfiancaOcr {
  /** Razao 0..1 de caracteres esperados (3 casas). */
  confianca: number;
  /** true -> baixa confianca (rotear ao humano; nao confiar no grep). */
  baixa: boolean;
}

/**
 * Estima a confianca do texto de OCR. Texto vazio/curto -> baixa. So deve ser
 * chamado para documentos que usaram OCR (usou_ocr=true); para os demais a
 * confianca nao se aplica (null no banco).
 */
export function estimarConfiancaOcr(texto: string | null | undefined): ConfiancaOcr {
  const t = texto ?? "";
  const len = t.length;
  if (len === 0) return { confianca: 0, baixa: true };

  const esperados = (t.match(ESPERADOS) ?? []).length;
  const confianca = Math.round((esperados / len) * 1000) / 1000;
  const semEspaco = t.replace(/\s/g, "").length;
  const baixa = confianca < LIMIAR_CONFIANCA || semEspaco < MIN_CHARS_NAO_ESPACO;
  return { confianca, baixa };
}
