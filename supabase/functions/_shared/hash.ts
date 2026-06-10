// =====================================================================
// _shared/hash.ts
// Hash deterministico do conteudo textual canonico de um processo (RF-19).
//
// Usado pelo pipeline de ingestao para decidir reindexacao: se o hash do
// conteudo canonico mudou em relacao ao persistido, o registro e marcado
// para reindexar; se igual, evita-se recomputar embeddings (US-10).
//
// Canonizacao (SPEC 3.4, passo 6): concatena `descricao` + `nome` + `etapa`
// em ORDEM FIXA, com SEPARADOR estavel entre os campos. Inclui `etapa` por
// ser o campo que mais evolui no snapshot vigente, garantindo reindexacao
// quando a etapa muda.
//
// A funcao e PURA e SINCRONA: nao depende de I/O externo (rede/disco). Usa
// apenas computacao em memoria (TextEncoder + FNV-1a 64 bits), portanto a
// mesma entrada produz sempre o mesmo hash.
// =====================================================================

/** Campos textuais canonicos que compoem o hash de conteudo. */
export interface ConteudoCanonico {
  descricao?: string | null;
  nome?: string | null;
  etapa?: string | null;
}

// Separador estavel entre campos: ASCII Unit Separator (0x1F). Improvavel de
// ocorrer em texto livre, evitando colisoes entre fronteiras de campo (ex.:
// {descricao:"ab", nome:"c"} != {descricao:"a", nome:"bc"}).
const FIELD_SEPARATOR = "\u001f";

/**
 * Produz o hash deterministico do conteudo textual canonico.
 *
 * Ordem fixa: descricao, nome, etapa. Valores ausentes (null/undefined)
 * sao normalizados para string vazia (mantem as posicoes estaveis). Alterar
 * qualquer um dos tres campos altera o hash resultante.
 */
export function hashConteudoCanonico(input: ConteudoCanonico): string {
  const canonical = [
    input.descricao ?? "",
    input.nome ?? "",
    input.etapa ?? "",
  ].join(FIELD_SEPARATOR);
  return fnv1a64Hex(canonical);
}

/**
 * Hash deterministico de um texto arbitrario (FNV-1a 64, hex 16 digitos).
 * Mesma funcao do hashConteudoCanonico, exposta para conteudos que ja chegam
 * canonizados pelo caller (ex.: Effecti hasheia JSON.stringify(payload_bruto)).
 */
export function hashTexto(texto: string): string {
  return fnv1a64Hex(texto);
}

// ---------------------------------------------------------------------
// FNV-1a 64 bits sobre os bytes UTF-8 da entrada. Deterministico e estavel
// entre execucoes; saida em hexadecimal de 16 digitos (zero-padded).
// ---------------------------------------------------------------------

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function fnv1a64Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}
