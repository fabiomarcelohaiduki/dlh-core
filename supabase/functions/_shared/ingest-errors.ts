// =====================================================================
// _shared/ingest-errors.ts
// Registro padronizado de falhas em erros_ingestao (US-16, RF-27, RF-40).
//
// Falhas por item (coleta/tratamento/indexacao) viram um registro visivel
// em erros_ingestao SEM derrubar o lote (RNF-05). O registro alimenta a tela
// de Erros e o link de investigacao do edital. Best-effort: a propria
// auditoria do erro nunca lanca (nao pode mascarar a falha original).
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { captureException } from "./audit.ts";

/** Etapas do pipeline (capitalizadas conforme o substrato/secao 2.1). */
export type EtapaIngestao = "Coleta" | "Tratamento" | "Indexacao" | "Persistencia";

/** Severidade do erro (secao 2.1). */
export type SeveridadeIngestao = "alta" | "media" | "baixa";

export interface IngestErroInput {
  execucaoId?: string | null;
  avisoId?: string | null;
  severidade: SeveridadeIngestao;
  etapa: EtapaIngestao;
  mensagem: string;
  /**
   * Discriminador de origem do erro (ex.: 'aviso', 'processo-venda-governamental').
   * Omitido => o banco aplica o default 'aviso' (compat Effecti) (RF-34).
   */
  origem?: string | null;
  /** Recurso da fonte multi-recurso (ex.: 'processos'); null para Effecti. */
  recurso?: string | null;
  /**
   * Referencia generica ao registro de origem (ex.: nomus_processos.id).
   * NUNCA armazena payload (SEC-09): apenas o id do registro afetado.
   */
  registroId?: string | null;
}

/**
 * Insere um registro em erros_ingestao. `db` deve ser service_role (escrita
 * server-side no contexto do pipeline). Best-effort: erros de gravacao do
 * proprio log vao para console + Sentry, sem propagar.
 */
export async function recordIngestErro(
  db: SupabaseClient,
  input: IngestErroInput,
): Promise<void> {
  try {
    // Linha base (compat Effecti). origem/recurso/registro_id sao colunas
    // aditivas (secao 2.1.6): so entram quando informadas, preservando o
    // default 'aviso' do banco para os erros do Effecti.
    const row: Record<string, unknown> = {
      execucao_id: input.execucaoId ?? null,
      aviso_id: input.avisoId ?? null,
      severidade: input.severidade,
      etapa: input.etapa,
      mensagem: input.mensagem,
      quando: new Date().toISOString(),
      status_reprocesso: "pendente",
    };
    if (input.origem !== undefined && input.origem !== null) row.origem = input.origem;
    if (input.recurso !== undefined) row.recurso = input.recurso ?? null;
    if (input.registroId !== undefined) row.registro_id = input.registroId ?? null;

    const { error } = await db.from("erros_ingestao").insert(row);
    if (error) {
      console.error("[ingest-errors] falha ao registrar erro de ingestao", {
        etapa: input.etapa,
        avisoId: input.avisoId,
        error: error.message,
      });
      await captureException(error, { scope: "ingest-errors", etapa: input.etapa });
    }
  } catch (err) {
    console.error("[ingest-errors] excecao ao registrar erro de ingestao", {
      etapa: input.etapa,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Extrai uma mensagem legivel de qualquer erro. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
