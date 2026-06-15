// =====================================================================
// Edge Function: v1-acervo-ler-documento
//   -> POST /v1/acervo/ler-documento   (contrato versionado /v1)
//
// Leitura integral PAGINADA de um documento do ACERVO por id. Complemento
// da busca semantica: quando o trecho casado (chunk) nao basta, a Lia le o
// documento inteiro a partir do documento_id devolvido pela busca.
//   - Recebe { documento_id, offset?, limite? } e retorna
//     { documento: { documento_id, nome_arquivo, tipo_documento, extensao,
//       usou_ocr, via, texto_chars, offset, limite, texto, fontes },
//       tem_mais } | 404 quando o id nao existe.
//   - Documentos podem ser enormes (ate ~4,4M chars): a leitura e paginada
//     por caracteres. offset normalizado para >= 0; limite normalizado em
//     [1, MAX_DOC_CHARS] (default DEFAULT_DOC_CHARS). tem_mais indica se
//     ha mais texto alem da janela retornada (offset + len < texto_chars).
//   - Chama a RPC ler_documento(p_documento_id, p_offset, p_limite),
//     SECURITY DEFINER (executavel so por service_role).
//
// Autenticacao /v1: aceita a API key de servico read-only da Lia (Bearer,
// guardada no Vault) OU a sessao do cockpit. Sem credencial valida -> 401.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, principalLabel } from "../_shared/service-auth.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  acervoLerDocumentoSchema,
  normalizeDocLimite,
  normalizeDocOffset,
  parseJsonBody,
} from "../_shared/validation.ts";

/** Linha retornada pela RPC public.ler_documento. */
interface DocumentoRow {
  documento_id: string | null;
  nome_arquivo: string | null;
  tipo_documento: string | null;
  extensao: string | null;
  usou_ocr: boolean | null;
  via: string | null;
  texto_chars: number | null;
  offset_aplicado: number | null;
  limite_aplicado: number | null;
  texto: string | null;
  fontes: string[] | null;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao primeiro: nao processa corpo sem credencial valida (401/403).
    const principal = await authenticateV1(req);

    // Validacao server-side (zod). Falha de schema -> 422.
    const { documento_id, offset, limite } = await parseJsonBody(req, acervoLerDocumentoSchema, {
      validationStatus: 422,
    });
    const normalizedOffset = normalizeDocOffset(offset);
    const normalizedLimite = normalizeDocLimite(limite);

    // Leitura paginada via RPC SECURITY DEFINER, executada server-side.
    const service = createServiceClient();
    const { data, error } = await service.rpc("ler_documento", {
      p_documento_id: documento_id,
      p_offset: normalizedOffset,
      p_limite: normalizedLimite,
    });
    if (error) {
      throw new HttpError(500, "ler_documento_failed", "falha ao ler o documento");
    }

    const rows = (data ?? []) as DocumentoRow[];
    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "documento_nao_encontrado", "documento nao encontrado");
    }

    const texto = row.texto ?? "";
    const textoChars = typeof row.texto_chars === "number" ? row.texto_chars : texto.length;
    const offsetAplicado = typeof row.offset_aplicado === "number"
      ? row.offset_aplicado
      : normalizedOffset;
    const limiteAplicado = typeof row.limite_aplicado === "number"
      ? row.limite_aplicado
      : normalizedLimite;
    // Ha mais texto se a janela retornada nao alcancou o fim do documento.
    const temMais = offsetAplicado + texto.length < textoChars;

    const documento = {
      documento_id: row.documento_id ?? documento_id,
      nome_arquivo: row.nome_arquivo ?? null,
      tipo_documento: row.tipo_documento ?? null,
      extensao: row.extensao ?? null,
      usou_ocr: typeof row.usou_ocr === "boolean" ? row.usou_ocr : null,
      via: row.via ?? null,
      texto_chars: textoChars,
      offset: offsetAplicado,
      limite: limiteAplicado,
      texto,
      fontes: Array.isArray(row.fontes) ? row.fontes : [],
    };

    // Auditoria: registra a leitura SEM o conteudo do documento.
    await logSensitiveAction({
      tabela: "documentos",
      acao: "ler_documento_acervo",
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        documento_id: documento.documento_id,
        offset: offsetAplicado,
        limite: limiteAplicado,
        retornou_chars: texto.length,
        tem_mais: temMais,
      },
    });

    return jsonResponse({ documento, tem_mais: temMais }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "v1-acervo-ler-documento" });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
