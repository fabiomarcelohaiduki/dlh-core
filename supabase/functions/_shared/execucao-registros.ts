// =====================================================================
// _shared/execucao-registros.ts
// Write-back do ledger `execucao_registros`: o efeito de UMA execucao sobre UM
// registro (novo|atualizado), na granularidade (fonte, registro_origem_id) da
// lista mestra. Effecti e Nomus chamam isto na borda (Edge), onde ja decidem
// inserido/atualizado por registro; Gmail/Drive gravam dentro das proprias
// funcoes de descoberta no Postgres (sao a persistencia daquelas fontes).
//
// O clique numa execucao na guia Coleta cruza este ledger (RPC
// coleta_registros_por_execucao) para recortar a guia Dados exatamente nos
// registros daquela rodada, rotulados novo vs atualizado.
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { type EfeitoColeta } from "./registro-types.ts";

/**
 * Grava o efeito desta execucao sobre um registro no ledger. Idempotente: a PK
 * (execucao_id, fonte, registro_origem_id) com ignoreDuplicates preserva o
 * PRIMEIRO efeito da rodada (um 'novo' nao e rebaixado por um re-toque tardio).
 * Best-effort: falha aqui NAO derruba a coleta (so loga) — o ledger e recorte
 * de visualizacao, nao caminho critico de ingestao.
 */
export async function registrarEfeitoColeta(
  db: SupabaseClient,
  execucaoId: string,
  fonte: string,
  registroOrigemId: string,
  efeito: EfeitoColeta,
): Promise<void> {
  const { error } = await db
    .from("execucao_registros")
    .upsert(
      { execucao_id: execucaoId, fonte, registro_origem_id: registroOrigemId, efeito },
      { onConflict: "execucao_id,fonte,registro_origem_id", ignoreDuplicates: true },
    );
  if (error) {
    console.error("[execucao-registros] falha ao gravar efeito no ledger", {
      error: error.message,
      execucaoId,
      fonte,
      registroOrigemId,
      efeito,
    });
  }
}
