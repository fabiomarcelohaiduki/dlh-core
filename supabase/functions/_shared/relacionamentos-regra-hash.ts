// =====================================================================
// _shared/relacionamentos-regra-hash.ts
// Hash deterministico dos CAMPOS DE MATCHING de uma regra do catalogo
// (public.catalogo_regras_vinculo). Fonte unica de verdade compartilhada
// entre as Edges `relacionamentos-dry-run` (feat-017) e
// `relacionamentos-ativar` (feat-018): ambas DEVEM produzir o MESMO
// hash para a MESMA regra, senao o gate de frescor STATELESS (E9) falha.
//
// CONTRATO DO GATE DE FRESCOR (E9): nao ha armazenamento server-side do
// "ultimo hash". O dry-run devolve `regra_hash` computado dos campos de
// matching da regra; a UI guarda esse hash e o reenvia ao ativar; o
// reprocessar RECOMPUTA o hash da regra ATUAL com ESTA MESMA funcao e
// compara. Divergiu => 409 (regra mudou, refaca o dry-run).
//
// Somente os campos que definem o COMPORTAMENTO DE MATCHING entram no
// hash. Campos cosmeticos/operacionais (nome, ativa, versao, timestamps,
// modo_disparo) NAO entram: editar o `nome` ou alternar `ativa` NAO deve
// invalidar um dry-run cujo matching continua identico.
//
// Reusa o padrao de hashing do dlh-core (hashTexto = FNV-1a 64, hex 16).
// =====================================================================

import { hashTexto } from "./hash.ts";

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

// Separador estavel entre campos (ASCII Unit Separator, 0x1F) e entre itens
// da sequencia (ASCII Record Separator, 0x1E). Improvaveis em texto livre,
// evitam colisoes de fronteira entre campos/itens.
const FIELD_SEPARATOR = "\u001f";
const SEQUENCE_SEPARATOR = "\u001e";

/**
 * Produz o hash deterministico dos campos de matching de uma regra.
 *
 * Ordem fixa: origem_tipo, campo_origem, destino_tipo, campo_destino,
 * combinacao, sequencia. Valores ausentes viram string vazia (mantem as
 * posicoes estaveis). A sequencia (array) e normalizada com um separador
 * dedicado para nao colidir com o separador de campos.
 */
export function hashRegraMatching(regra: RegraMatchingFields): string {
  const sequencia = Array.isArray(regra.sequencia) ? regra.sequencia.join(SEQUENCE_SEPARATOR) : "";
  const canonical = [
    regra.origem_tipo ?? "",
    regra.campo_origem ?? "",
    regra.destino_tipo ?? "",
    regra.campo_destino ?? "",
    regra.combinacao ?? "",
    sequencia,
  ].join(FIELD_SEPARATOR);
  return hashTexto(canonical);
}
