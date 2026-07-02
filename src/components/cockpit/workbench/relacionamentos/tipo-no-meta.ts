// =====================================================================
// Metadata compartilhada dos tipos de no de Relacionamentos.
//
// Fonte unica dos rotulos PT-BR por tipo, consumida pela legenda do grafo,
// pelo editor de abreviacoes e pelas views semanticas — sem depender da
// antiga view de parametros (esvaziada na F5, aguardando remocao fisica).
// =====================================================================

import type { RelacionamentoTipoNo } from "@/lib/api/relacionamentos-types";

/** Rotulos PT-BR dos 10 tipos canonicos (espelham o seed de config_tipos_no). */
export const TIPO_NO_LABEL: Record<RelacionamentoTipoNo, string> = {
  aviso: "Aviso",
  processo: "Processo",
  documento: "Documento",
  pessoa: "Pessoa",
  produto: "Produto",
  linha: "Linha",
  sku: "SKU",
  preco: "Preço",
  politica: "Política",
  cotacao_diretriz: "Diretriz",
};

/**
 * Resolve o rotulo humano de um tipo com fallback tolerante a tipos custom
 * (nao presentes no enum canonico): capitaliza a primeira letra.
 */
export function tipoNoLabel(tipo: string): string {
  const known = TIPO_NO_LABEL[tipo as RelacionamentoTipoNo];
  if (known) return known;
  if (tipo.length === 0) return tipo;
  return tipo.charAt(0).toUpperCase() + tipo.slice(1);
}

/** Cor semantica de fallback quando um tipo ainda nao definiu cor_semantica. */
export const COR_SEMANTICA_FALLBACK = "#71717a";
