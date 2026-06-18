// =====================================================================
// _shared/triagem-janela.ts
// Janela de datas CONFIGURAVEL da fila de triagem. Restringe QUAIS avisos
// entram na fila com base na abertura dos lances (avisos.data_final, UTC real).
//
//   triar_apenas_futuros   -> exclui avisos cuja abertura ja passou.
//   triagem_horizonte_dias -> teto de dias a partir de agora (0 = sem teto).
//
// Avisos com data_final NULL entram SEMPRE (cada clausula inclui data_final
// IS NULL). Defaults (false / 0) => sem filtro, preserva o comportamento atual.
// Usado nos DOIS gates da fila: a esteira IA (triagem-fila) e o cockpit
// (automacao-avisos) leem a MESMA config e aplicam o MESMO filtro.
// =====================================================================

import { createServiceClient } from "./supabase.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const MS_POR_DIA = 86_400_000;

export interface JanelaTriagem {
  triarApenasFuturos: boolean;
  horizonteDias: number;
}

/** Le a janela do singleton config_automacao. Ausente => sem filtro. */
export async function loadJanelaTriagem(db: ServiceClient): Promise<JanelaTriagem> {
  const { data, error } = await db
    .from("config_automacao")
    .select("triar_apenas_futuros, triagem_horizonte_dias")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler config_automacao (janela): ${error.message}`);
  }
  const horizonte = typeof data?.triagem_horizonte_dias === "number"
    ? Math.max(0, Math.trunc(data.triagem_horizonte_dias))
    : 0;
  return {
    triarApenasFuturos: data?.triar_apenas_futuros === true,
    horizonteDias: horizonte,
  };
}

/**
 * Expressoes .or() do PostgREST que restringem avisos.data_final a janela.
 * Cada clausula inclui `data_final.is.null` para que avisos sem abertura
 * conhecida entrem sempre. Lista vazia => sem filtro (comportamento padrao).
 * Multiplos .or() aplicados sao combinados em AND pelo PostgREST.
 */
export function janelaOrFilters(janela: JanelaTriagem, agora = new Date()): string[] {
  const filtros: string[] = [];
  if (janela.triarApenasFuturos) {
    filtros.push(`data_final.gte.${agora.toISOString()},data_final.is.null`);
  }
  if (janela.horizonteDias > 0) {
    const limite = new Date(agora.getTime() + janela.horizonteDias * MS_POR_DIA);
    filtros.push(`data_final.lte.${limite.toISOString()},data_final.is.null`);
  }
  return filtros;
}
