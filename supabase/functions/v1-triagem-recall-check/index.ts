// =====================================================================
// Edge Function: v1-triagem-recall-check  (Caminho 2 - DIAGNOSTICO read-only)
//   -> POST /v1-triagem-recall-check   body: { aviso_id }
//
// Diagnostica o RECALL DO EFFECTI de UM aviso SEM escrever nada: resolve a
// lista-ANCORA (painel /all quando ha credencial; fail-open ao subset
// itensEdital), compara com os itens JA extraidos do aviso (numero OU
// normDesc) e devolve os FALTANTES + a flag determinista `precisa_reextrair`.
//
// Existe para o ORQUESTRADOR de triagem fechar o buraco de recall DENTRO da
// mesma rodada do aviso: ele despacha o Extrator, chama este check e, se
// `precisa_reextrair`, re-despacha o Extrator com a lista de faltantes ANTES
// do veredito. A regra critica (ha furo?) fica DETERMINISTICA no servidor
// (SOM): a IA so obedece a flag. Reusa o nucleo de ../_shared/triagem-recall.ts
// — mesma logica do gate 4.3 da Edge de veredito, sem efeito colateral.
//
// Autenticacao (RNF-01 / SEC-1): authenticateV1 com requiredScope
// read-only:busca-semantica (recurso de LEITURA). Sem credencial -> 401;
// escopo != read-only:busca-semantica (ex.: write:triagem) ou sessao humana
// -> 403. Leitura roda via service_role. logSensitiveAction registra principal
// + contagens, sem conteudo de aviso/edital.
//
// Codigos: 200 ok; 400 body invalido (zod); 401 sem credencial; 403 escopo
// invalido; 404 aviso inexistente.
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, LIA_SERVICE_SCOPE, principalLabel } from "../_shared/service-auth.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  faltantesDoEffecti,
  type ItensEditalRow,
  loadItensIndexDoAviso,
  resolverAncoraEffecti,
} from "../_shared/triagem-recall.ts";

const FUNCTION_SEGMENT = "v1-triagem-recall-check";

const recallCheckBodySchema = z.object({
  aviso_id: z.string().uuid("aviso_id deve ser um uuid valido"),
});

type RecallCheckBody = z.infer<typeof recallCheckBodySchema>;

/** Linha do aviso lida para o diagnostico (subset itensEdital + effecti_id). */
interface AvisoRow {
  id: string;
  effecti_id: string;
  // Subset itensEdital extraido do payload_bruto via JSON path (SEC-4).
  itens_effecti: unknown;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao na borda: recurso de LEITURA. Sem credencial -> 401;
    // escopo != read-only:busca-semantica -> 403. Antes de tocar o banco.
    const principal = await authenticateV1(req, { requiredScope: LIA_SERVICE_SCOPE });

    const body: RecallCheckBody = await parseJsonBody(req, recallCheckBodySchema);
    const db = createServiceClient();

    // 1) Carrega o aviso (404 quando inexistente). So o necessario para o
    //    diagnostico: effecti_id (ancora) + subset itensEdital (fail-open).
    const { data: avisoRaw, error: avisoErr } = await db
      .from("avisos")
      .select("id, effecti_id, itens_effecti:payload_bruto->itensEdital")
      .eq("id", body.aviso_id)
      .maybeSingle();
    if (avisoErr) {
      throw new Error(`falha ao consultar o aviso: ${avisoErr.message}`);
    }
    if (!avisoRaw) {
      throw new HttpError(404, "aviso_nao_encontrado", "aviso inexistente");
    }
    // O alias por arrow-operator (payload_bruto->itensEdital) impede a inferencia
    // estatica do PostgREST (GenericStringError); cast via unknown.
    const aviso = avisoRaw as unknown as AvisoRow;

    // 2) Indice dos itens JA extraidos do aviso (numero + normDesc), agregando
    //    TODOS os docs por effecti_id. Carregado ANTES de bater no painel: se
    //    nada foi extraido ainda (total === 0) nao ha o que reconciliar e o
    //    diagnostico devolve faltantes=[] (o "ainda nao extraido" e tratado pelo
    //    gate de recall 4.1 da Edge de veredito, nao gera faltante falso aqui).
    const idx = await loadItensIndexDoAviso(db, aviso.effecti_id);

    // 3) Lista-ANCORA: painel /all quando ha credencial; fail-open ao subset.
    const subset = Array.isArray(aviso.itens_effecti)
      ? (aviso.itens_effecti as ItensEditalRow[])
      : [];
    const ancora = await resolverAncoraEffecti(aviso.effecti_id, subset);

    // 4) Faltantes (numero OU normDesc) — identico ao gate 4.3 do veredito.
    const faltantesRows = idx.total > 0 && ancora.itens.length > 0
      ? faltantesDoEffecti(ancora.itens, idx)
      : [];
    const faltantes = faltantesRows.map((e) => ({
      numero: e.item != null ? String(e.item) : null,
      descricao: e.produtoLicitadoSemTags ?? null,
    }));

    const resposta = {
      aviso_id: aviso.id,
      ancora: ancora.origem,
      total_piso: ancora.itens.length,
      total_extraido: idx.total,
      faltantes,
      precisa_reextrair: faltantes.length > 0,
    };

    // Auditoria do acesso /v1: principal + contagens; SEM conteudo de aviso.
    await logSensitiveAction({
      tabela: "avisos",
      acao: "v1_triagem_recall_check",
      usuario: principalLabel(principal),
      dadosNovos: {
        via: principal.kind,
        aviso_id: aviso.id,
        ancora: resposta.ancora,
        total_piso: resposta.total_piso,
        total_extraido: resposta.total_extraido,
        faltantes: faltantes.length,
        precisa_reextrair: resposta.precisa_reextrair,
      },
    });

    return jsonResponse(resposta, 200);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
