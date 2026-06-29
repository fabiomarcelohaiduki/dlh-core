// =====================================================================
// _shared/link-original.ts
// Helper PURO (sem rede) de montagem do link publico (`link_original`) de um
// registro coletado, por fonte. Deterministico: mesma entrada -> mesma saida.
// NAO faz fetch nem importa cliente HTTP. Espelha os padroes de URL ja usados
// pelo runner (documentos-descobrir) sem acopla-los.
//
//   - drive:   https://drive.google.com/file/d/{file_id}/view
//   - gmail:   https://mail.google.com/mail/u/0/#all/{thread_id}
//              fallback https://mail.google.com/mail/u/0/#inbox/{message_id}
//   - effecti: https://minha.effecti.com.br/#/aviso-edital-minhas/{effecti_id}
//   - nomus:   sempre null (sistema interno, sem link publico)
// =====================================================================

import type { FonteColeta } from "./registro-types.ts";

/**
 * Dados minimos (extraidos de documento_vinculos.ref_obtencao e/ou do
 * registro_origem_id Effecti) necessarios para montar o link publico.
 * Todos opcionais/null-safe: a ausencia resulta em link null, nunca em erro.
 */
export interface LinkOriginalDados {
  /** Drive: ref_obtencao.file_id. */
  file_id?: string | null;
  /** Gmail (preferencial): ref_obtencao.thread_id. */
  thread_id?: string | null;
  /** Gmail (fallback): ref_obtencao.message_id. */
  message_id?: string | null;
  /** Effecti: registro_origem_id (== effecti_id / idLicitacao). */
  effecti_id?: string | null;
}

/** Normaliza um valor textual opcional para string trimada ("" quando ausente). */
function normalizar(valor: string | null | undefined): string {
  return typeof valor === "string" ? valor.trim() : "";
}

/**
 * Monta o link publico de origem do registro para a `fonte` informada.
 * Funcao pura e deterministica; retorna `null` quando a fonte nao expoe link
 * publico (Nomus) ou quando os dados necessarios estao ausentes.
 */
export function montarLinkOriginal(
  fonte: FonteColeta,
  dados: LinkOriginalDados,
): string | null {
  switch (fonte) {
    case "drive": {
      const fileId = normalizar(dados.file_id);
      return fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
    }
    case "gmail": {
      const threadId = normalizar(dados.thread_id);
      if (threadId) {
        return `https://mail.google.com/mail/u/0/#all/${threadId}`;
      }
      const messageId = normalizar(dados.message_id);
      if (messageId) {
        return `https://mail.google.com/mail/u/0/#inbox/${messageId}`;
      }
      return null;
    }
    case "effecti": {
      const effectiId = normalizar(dados.effecti_id);
      return effectiId
        ? `https://minha.effecti.com.br/#/aviso-edital-minhas/${effectiId}`
        : null;
    }
    case "nomus":
      // Sistema interno: nunca expoe link publico.
      return null;
    default:
      return null;
  }
}
