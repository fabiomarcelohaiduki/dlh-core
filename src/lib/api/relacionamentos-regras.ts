// =====================================================================
// Wrapper fino de API para o catalogo de regras humanas (catalogo_regras_vinculo).
// Caminho da Edge: /relacionamentos-regras
//
// Endpoints consumidos:
//   GET    /relacionamentos-regras        listar (filtro ?ativa=&limit=&offset=)
//   GET    /relacionamentos-regras/:id    obter 1 regra (404 se inexistente)
//   POST   /relacionamentos-regras        criar
//   PUT    /relacionamentos-regras        atualizar (parcial)
//   DELETE /relacionamentos-regras/:id    remover (409 se ha vinculos pendentes)
//
// Respostas e payloads permanecem em snake_case (espelha as tabelas).
// =====================================================================

import { apiFetch, buildQuery } from "@/lib/api/client";
import type {
  ListRelacionamentosRegrasParams,
  Regra,
  RegraCreateInput,
  RegraUpdateInput,
  RelacionamentoPaginated,
} from "@/lib/api/relacionamentos-types";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

const PATH = "relacionamentos-regras";

// ---------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------

/** Lista regras humanas da org (filtro ?ativa=&limit=&offset=). */
export function listRelacionamentosRegras(
  params: ListRelacionamentosRegrasParams = {},
): Promise<RelacionamentoPaginated<Regra>> {
  const { ativa, limit, offset } = params;
  return apiFetch<RelacionamentoPaginated<Regra>>(
    `${PATH}${buildQuery({ ativa, limit, offset })}`,
    { method: "GET" },
  );
}

/** Obtem 1 regra por id (404 se inexistente ou de outra org). */
export function getRelacionamentosRegra(id: string): Promise<Regra> {
  return apiFetch<Regra>(`${PATH}/${id}`, { method: "GET" });
}

/** Cria uma regra humana (validacao zod anti numero_pregao no backend). */
export function createRelacionamentosRegra(input: RegraCreateInput): Promise<Regra> {
  return apiFetch<Regra>(PATH, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Atualiza uma regra humana (parcial). */
export function updateRelacionamentosRegra(
  id: string,
  input: RegraUpdateInput,
): Promise<Regra> {
  return apiFetch<Regra>(`${PATH}/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** Remove uma regra humana (409 quando ha vinculos inferidos pendentes). */
export function deleteRelacionamentosRegra(id: string): Promise<{ ok: boolean; id: string }> {
  return apiFetch<{ ok: boolean; id: string }>(`${PATH}/${id}`, { method: "DELETE" });
}

/**
 * Atalho para o caso comum "ativar/desativar regra sem mexer no resto".
 * Envia PUT com apenas { ativa } para o backend.
 */
export function toggleRelacionamentosRegra(
  id: string,
  ativa: boolean,
): Promise<Regra> {
  return updateRelacionamentosRegra(id, { ativa });
}
