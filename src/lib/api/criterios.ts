import { apiFetch, buildQuery } from "@/lib/api/client";
import type {
  CotacaoDiretriz,
  CotacaoNivel,
  CotacaoRegra,
  CotacaoTipoRegra,
  Paginated,
  PoliticaParticipa,
  PoliticaParticipacao,
} from "@/lib/api/types";

// ---------------------------------------------------------------------
// Dominio E — Diretrizes/regras de cotacao e politica de participacao.
// Cada recurso e listado por nivel/escopo (LINHA ou PRODUTO).
// Respostas e payloads permanecem em snake_case no frontend.
// ---------------------------------------------------------------------

/** Filtro comum das listagens de criterios (por nivel/escopo). */
export interface ListCriteriosParams {
  nivel?: CotacaoNivel;
  escopo_id?: string;
  limit?: number;
  offset?: number;
}

// --- Diretrizes de cotacao -----------------------------------------

export function listDiretrizes(
  params: ListCriteriosParams = {},
): Promise<Paginated<CotacaoDiretriz>> {
  return apiFetch<Paginated<CotacaoDiretriz>>(
    `produtos-criterios/cotacao-diretrizes${buildQuery(params)}`,
    { method: "GET" },
  );
}

export interface CotacaoDiretrizInput {
  nivel: CotacaoNivel;
  escopo_id: string;
  texto: string;
}

export function createDiretriz(
  input: CotacaoDiretrizInput,
): Promise<CotacaoDiretriz> {
  return apiFetch<CotacaoDiretriz>("produtos-criterios/cotacao-diretrizes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateDiretriz(
  id: string,
  input: Partial<CotacaoDiretrizInput>,
): Promise<CotacaoDiretriz> {
  return apiFetch<CotacaoDiretriz>(
    `produtos-criterios/cotacao-diretrizes/${id}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function deleteDiretriz(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `produtos-criterios/cotacao-diretrizes/${id}`,
    { method: "DELETE" },
  );
}

// --- Regras estruturadas de cotacao --------------------------------

export function listRegras(
  params: ListCriteriosParams = {},
): Promise<Paginated<CotacaoRegra>> {
  return apiFetch<Paginated<CotacaoRegra>>(
    `produtos-criterios/cotacao-regras${buildQuery(params)}`,
    { method: "GET" },
  );
}

export interface CotacaoRegraInput {
  nivel: CotacaoNivel;
  escopo_id: string;
  atributo: string;
  tipo_regra: CotacaoTipoRegra;
  valor_min?: number | null;
  valor_max?: number | null;
  substituicao?: string | null;
}

export function createRegra(input: CotacaoRegraInput): Promise<CotacaoRegra> {
  return apiFetch<CotacaoRegra>("produtos-criterios/cotacao-regras", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateRegra(
  id: string,
  input: Partial<CotacaoRegraInput>,
): Promise<CotacaoRegra> {
  return apiFetch<CotacaoRegra>(`produtos-criterios/cotacao-regras/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteRegra(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`produtos-criterios/cotacao-regras/${id}`, {
    method: "DELETE",
  });
}

// --- Politica de participacao --------------------------------------

export function listPolitica(
  params: ListCriteriosParams = {},
): Promise<Paginated<PoliticaParticipacao>> {
  return apiFetch<Paginated<PoliticaParticipacao>>(
    `produtos-criterios/politica-participacao${buildQuery(params)}`,
    { method: "GET" },
  );
}

export interface PoliticaParticipacaoInput {
  nivel: CotacaoNivel;
  escopo_id: string;
  participa: PoliticaParticipa;
  condicao?: string | null;
  diretriz_texto?: string | null;
  preferencia?: string | null;
}

export function createPolitica(
  input: PoliticaParticipacaoInput,
): Promise<PoliticaParticipacao> {
  return apiFetch<PoliticaParticipacao>(
    "produtos-criterios/politica-participacao",
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function updatePolitica(
  id: string,
  input: Partial<PoliticaParticipacaoInput>,
): Promise<PoliticaParticipacao> {
  return apiFetch<PoliticaParticipacao>(
    `produtos-criterios/politica-participacao/${id}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function deletePolitica(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `produtos-criterios/politica-participacao/${id}`,
    { method: "DELETE" },
  );
}
