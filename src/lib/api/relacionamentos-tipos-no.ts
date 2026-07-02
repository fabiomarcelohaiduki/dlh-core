// =====================================================================
// Wrapper fino de API para os tipos de no (config_tipos_no).
// Caminho da Edge: /relacionamentos-tipos-no
//
// Endpoints consumidos:
//   GET  /relacionamentos-tipos-no        tipos da org + campos reais da
//                                         tabela_fonte de cada um (1 roundtrip
//                                         alimenta os dropdowns do RegraForm)
//   POST /relacionamentos-tipos-no        criar tipo novo (tipo + label +
//                                         tabela_fonte; 422 se a tabela nao
//                                         existir ou nao tiver coluna util)
//   PUT  /relacionamentos-tipos-no/:tipo  editar label / tabela_fonte / ativo
//
// Respostas e payloads permanecem em snake_case.
// =====================================================================

import { apiFetch } from "@/lib/api/client";
import type { RelacionamentoTipoNo } from "@/lib/api/relacionamentos-types";

const PATH = "relacionamentos-tipos-no";

// ---------------------------------------------------------------------
// Tipos do contrato
// ---------------------------------------------------------------------

/** Coluna utilizavel da tabela_fonte de um tipo (chave de match de regra). */
export interface TipoNoCampo {
  campo: string;
  /** data_type do information_schema (ex: "text", "uuid", "timestamp..."). */
  tipo_dado: string;
}

/** Tipo de no da org com os campos reais da sua tabela_fonte embutidos. */
export interface TipoNoItem {
  tipo: RelacionamentoTipoNo;
  label: string;
  icone: string;
  cor: string | null;
  ordem: number;
  ativo: boolean;
  /** Tabela do substrato que da os campos; null = tipo sem fonte mapeada. */
  tabela_fonte: string | null;
  /** Vazio quando tabela_fonte e null (campo vira input livre na UI). */
  campos: TipoNoCampo[];
}

/** Input de criacao de tipo novo pelo cockpit. */
export interface TipoNoCreateInput {
  tipo: string;
  label: string;
  tabela_fonte: string;
  icone?: string;
  cor?: string;
}

/** Input de edicao (parcial) de um tipo existente. */
export interface TipoNoUpdateInput {
  label?: string;
  tabela_fonte?: string;
  ativo?: boolean;
}

// ---------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------

/** Lista os tipos da org com os campos reais de cada tabela_fonte. */
export function listTiposNo(): Promise<{ tipos: TipoNoItem[] }> {
  return apiFetch<{ tipos: TipoNoItem[] }>(PATH, { method: "GET" });
}

/** Cria um tipo novo (valida a tabela_fonte contra o schema real; 422 se invalida). */
export function createTipoNo(input: TipoNoCreateInput): Promise<TipoNoItem> {
  return apiFetch<TipoNoItem>(PATH, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Edita label / tabela_fonte / ativo de um tipo existente. */
export function updateTipoNo(
  tipo: string,
  input: TipoNoUpdateInput,
): Promise<TipoNoItem> {
  return apiFetch<TipoNoItem>(`${PATH}/${encodeURIComponent(tipo)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
