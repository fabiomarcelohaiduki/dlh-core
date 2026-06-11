// =====================================================================
// _shared/crypto.ts
// Primitivas de comparacao segura. UNICA implementacao de timingSafeEqual
// no projeto (antes duplicada e divergente em auth/service-auth/orquestrar/
// nomus-ingerir).
//
// Comparacao em tempo (aproximadamente) constante: percorre SEMPRE o maior
// comprimento e inclui a diferenca de tamanho no acumulador, para que o tempo
// de resposta nao revele quantos bytes do segredo conferem (nem o tamanho).
// Compara sobre os BYTES UTF-8 para nao vazar via diferenca de unidades de
// codigo.
// =====================================================================

const encoder = new TextEncoder();

/** Igualdade de strings em tempo constante (anti timing-attack). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
