// =====================================================================
// _shared/rest.ts
// Utilitarios de borda para Edge Functions REST/CRUD: roteamento por
// segmento de path, validacao de UUID, mapeamento de erros do PostgREST,
// montagem de payload a partir de campos presentes e delete idempotente
// com 404. Centraliza o que antes era copiado entre os handlers de CRUD.
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http.ts";

/** Regex de UUID v4 canonico (case-insensitive). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True quando o valor e um UUID valido. */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Valida que o id e UUID; senao lanca 404 (recurso inexistente). */
export function assertUuid(value: string | undefined, recurso: string): string {
  if (!isUuid(value)) {
    throw new HttpError(404, "nao_encontrado", `${recurso} nao encontrado`);
  }
  return value;
}

/**
 * Extrai os segmentos de rota apos o nome da funcao no pathname. Ex.: para
 * `/produtos-catalogo/produtos/<id>/skus` e segment `produtos-catalogo`
 * retorna `["produtos", "<id>", "skus"]`. Quando o segmento nao aparece
 * (chamada local/atipica) retorna o pathname inteiro segmentado.
 */
export function routeSegments(req: Request, functionSegment: string): string[] {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const idx = parts.indexOf(functionSegment);
  return idx >= 0 ? parts.slice(idx + 1) : parts;
}

/** True quando o erro do PostgREST e violacao de UNIQUE (23505). */
export function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

/** True quando o erro do PostgREST e violacao de FK (23503). */
export function isForeignKeyViolation(error: { code?: string } | null): boolean {
  return error?.code === "23503";
}

/**
 * Constroi um payload apenas com as chaves cujo valor foi informado
 * (`!== undefined`). Preserva `null` (limpa a coluna) e descarta ausentes
 * (preserva o valor atual em updates). Elimina os blocos repetitivos de
 * `if (input.x !== undefined) payload.x = input.x`.
 */
export function pickDefined<T extends Record<string, unknown>>(
  source: T,
  keys: readonly (keyof T)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key as string] = value;
  }
  return out;
}

/**
 * Remove uma linha por id (com filtros adicionais opcionais) de forma
 * idempotente: 500 em falha de banco, 404 quando nada foi removido. Retorna
 * o id removido. Centraliza o esqueleto comum dos handlers DELETE; pre-checks
 * de filhos (409) e pos-hooks (audit/chunks) ficam no chamador.
 */
export async function deleteRowById(
  db: SupabaseClient,
  params: {
    table: string;
    id: string;
    extraEq?: Record<string, string>;
    recurso: string;
    errorCode: string;
  },
): Promise<string> {
  let query = db.from(params.table).delete().eq("id", params.id);
  for (const [column, value] of Object.entries(params.extraEq ?? {})) {
    query = query.eq(column, value);
  }

  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    throw new HttpError(500, params.errorCode, `falha ao remover ${params.recurso}`);
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", `${params.recurso} nao encontrado`);
  }
  return data.id as string;
}
