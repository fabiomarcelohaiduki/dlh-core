// =====================================================================
// Espelho client-side de supabase/functions/_shared/relacionamentos-regra-hash.ts
//
// Reproduz BIT-A-BIT o hash deterministico dos CAMPOS DE MATCHING de uma
// regra (FNV-1a 64, hex 16). Serve ao gate de frescor STATELESS (E9): o
// RegraForm computa o hash dos campos ATUAIS e compara com o `regra_hash`
// do ultimo dry-run; se divergir, o dry-run esta obsoleto e o botao Ativar
// fica desabilitado (o servidor repete o gate e rejeita com 409).
//
// So os campos que definem o COMPORTAMENTO DE MATCHING entram no hash;
// campos cosmeticos (nome, ativa, versao, timestamps) NAO entram - editar
// o nome ou alternar ativa NAO deve invalidar um dry-run.
//
// IMPORTANTE: manter identico ao backend (separadores, ordem, normalizacao).
// =====================================================================

/** Subconjunto de campos de uma regra que determinam o matching. */
export interface RegraMatchingFields {
  origem_tipo: string;
  campo_origem: string;
  destino_tipo: string;
  campo_destino: string;
  combinacao: string;
  /** Sequencia de campos (regra composta); null/undefined para simples. */
  sequencia?: string[] | null;
}

// Separadores estaveis (identicos ao backend): Unit Separator (0x1F) entre
// campos e Record Separator (0x1E) entre itens da sequencia.
const FIELD_SEPARATOR = "\u001f";
const SEQUENCE_SEPARATOR = "\u001e";

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64 bits sobre os bytes UTF-8; hex 16 digitos (zero-padded). */
function fnv1a64Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Produz o hash deterministico dos campos de matching de uma regra.
 * Ordem fixa: origem_tipo, campo_origem, destino_tipo, campo_destino,
 * combinacao, sequencia. Valores ausentes viram string vazia.
 */
export function hashRegraMatching(regra: RegraMatchingFields): string {
  const sequencia = Array.isArray(regra.sequencia)
    ? regra.sequencia.join(SEQUENCE_SEPARATOR)
    : "";
  const canonical = [
    regra.origem_tipo ?? "",
    regra.campo_origem ?? "",
    regra.destino_tipo ?? "",
    regra.campo_destino ?? "",
    regra.combinacao ?? "",
    sequencia,
  ].join(FIELD_SEPARATOR);
  return fnv1a64Hex(canonical);
}
