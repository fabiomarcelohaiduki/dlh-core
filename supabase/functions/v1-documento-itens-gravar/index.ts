// =====================================================================
// Edge Function: v1-documento-itens-gravar  (write path da extracao de itens)
//   -> POST /v1-documento-itens-gravar
//
// A LIA e a extratora dos itens de licitacao (assinatura Lion, modelo forte).
// Ela le o texto JA extraido do documento, identifica a(s) lista(s) de itens e
// posta aqui o resultado. Como a Lia so tem SQL read-only no substrato, este
// recurso de ESCRITA persiste os itens com service_role (espelha o caminho do
// veredito).
//
// PER DOCUMENTO (dedup global): grava itens de UM documento; a fila resolve
// aviso -> documento_vinculos -> documento_itens, reaproveitando entre os N
// avisos que compartilham o mesmo edital. A Lia extrai 1x por documento.
//
// Idempotente: delete-then-insert por documento_id (re-extracao reescreve o
// conjunto). MULTIPLAS LISTAS convivem no mesmo documento via `lista_origem`
// (NUNCA fundir); a descricao de portal vem marcada fonte_descricao='portal'.
//
// Status (a Lia define; teto -> inobtenivel e server-side):
//   extraido  -> >=1 item gravado.
//   sem_itens -> documento processado, sem lista de itens (terminal).
//   ignorado  -> documento fora de escopo (proposta/ata/nota/imagem) — terminal.
//   erro      -> falha TRANSITORIA: incrementa tentativas; no teto vira
//                inobtenivel (terminal). Reprocessavel ate la.
//
// Autorizacao na borda (SEC-1): authenticateV1 com `write:triagem` ANTES do
// corpo. Sem credencial -> 401; escopo errado / sessao humana -> 403. Toda a
// escrita roda com service_role.
//
// Codigos: 200 ok; 400 body invalido (zod); 401 sem credencial; 403 escopo
// invalido; 404 documento inexistente.
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { authenticateV1, TRIAGEM_WRITE_SCOPE } from "../_shared/service-auth.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { createServiceClient } from "../_shared/supabase.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "v1-documento-itens-gravar";

// Teto de tentativas de extracao antes de marcar o documento como inobtenivel.
const TETO_TENTATIVAS = 3;

// ---------------------------------------------------------------------
// Validacao do corpo (zod). Body invalido -> 400 (parseJsonBody).
// ---------------------------------------------------------------------

const itemSchema = z.object({
  // Rotulo livre da lista (corpo do edital vs anexo TR). Distingue MULTIPLAS
  // listas no mesmo documento; o servidor NUNCA funde.
  lista_origem: z.string().min(1).max(200).optional().default("principal"),
  // 'portal' = descricao generica do portal (Comprasnet/PNCP), NAO canonica.
  fonte_descricao: z.enum(["tecnica", "portal"]).optional().default("tecnica"),
  item_numero: z.string().max(200).nullish(),
  lote: z.string().max(200).nullish(),
  // Descricao INTEGRAL do item (sem corte).
  descricao: z.string().min(1, "descricao e obrigatoria").max(20_000),
  unidade: z.string().max(100).nullish(),
  quantidade: z.number().finite().nullish(),
  // Preco UNITARIO de referencia (nullable: nem toda lista traz preco).
  preco_referencia: z.number().finite().nullish(),
  ordem: z.number().int().nullish(),
});

const bodySchema = z.object({
  documento_id: z.string().uuid("documento_id deve ser um uuid valido"),
  status: z.enum(["extraido", "sem_itens", "erro", "ignorado"]),
  itens: z.array(itemSchema).max(2_000).optional().default([]),
  motivo: z.string().max(2_000).nullish(),
}).superRefine((val, ctx) => {
  if (val.status === "extraido" && val.itens.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "status 'extraido' exige ao menos 1 item",
      path: ["itens"],
    });
  }
  if (val.status !== "extraido" && val.itens.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `status '${val.status}' nao aceita itens`,
      path: ["itens"],
    });
  }
});

type GravarBody = z.infer<typeof bodySchema>;

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");

    // Autorizacao na borda: recurso EXCLUSIVO de servico de ESCRITA.
    await authenticateV1(req, { requiredScope: TRIAGEM_WRITE_SCOPE });

    const body: GravarBody = await parseJsonBody(req, bodySchema);
    const db: ServiceClient = createServiceClient();

    // 1) Documento existe? (404 quando inexistente).
    const { data: docRaw, error: docErr } = await db
      .from("documentos")
      .select("id, itens_tentativas")
      .eq("id", body.documento_id)
      .maybeSingle();
    if (docErr) {
      throw new Error(`falha ao consultar o documento: ${docErr.message}`);
    }
    if (!docRaw) {
      throw new HttpError(404, "documento_nao_encontrado", "documento inexistente");
    }

    const agora = new Date().toISOString();

    // 2) Erro TRANSITORIO: incrementa tentativas; no teto vira inobtenivel
    //    (terminal). Nao toca nos itens ja gravados.
    if (body.status === "erro") {
      const tentativas = Number(docRaw.itens_tentativas ?? 0) + 1;
      const statusFinal = tentativas >= TETO_TENTATIVAS ? "inobtenivel" : "erro";
      const { error } = await db
        .from("documentos")
        .update({ itens_status: statusFinal, itens_tentativas: tentativas })
        .eq("id", body.documento_id);
      if (error) {
        throw new Error(`falha ao marcar erro de extracao: ${error.message}`);
      }
      return jsonResponse(
        { documento_id: body.documento_id, status: statusFinal, tentativas, itens_gravados: 0 },
        200,
      );
    }

    // 3) extraido / sem_itens / ignorado: idempotente — zera os itens do
    //    documento e regrava o conjunto recem-extraido.
    const { error: delErr } = await db
      .from("documento_itens")
      .delete()
      .eq("documento_id", body.documento_id);
    if (delErr) {
      throw new Error(`falha ao limpar itens anteriores: ${delErr.message}`);
    }

    let gravados = 0;
    // Itens recem-inseridos (id + chaves de correlacao). Permite ao chamador
    // referenciar o documento_item_id de itens que ELE acabou de extrair (ainda
    // nao estavam na fila) — necessario para persistir match por item no mesmo
    // run (ex.: PDF extraido na primeira triagem, que nao retorna a fila depois).
    let itensInseridos: { id: string; lista_origem: string; ordem: number | null }[] = [];
    if (body.itens.length > 0) {
      const rows = body.itens.map((it, i) => ({
        documento_id: body.documento_id,
        lista_origem: it.lista_origem,
        fonte_descricao: it.fonte_descricao,
        item_numero: it.item_numero ?? null,
        lote: it.lote ?? null,
        descricao: it.descricao,
        unidade: it.unidade ?? null,
        quantidade: it.quantidade ?? null,
        preco_referencia: it.preco_referencia ?? null,
        ordem: it.ordem ?? i + 1,
      }));
      const { data: ins, error: insErr } = await db
        .from("documento_itens")
        .insert(rows)
        .select("id, lista_origem, ordem");
      if (insErr) {
        throw new Error(`falha ao inserir itens: ${insErr.message}`);
      }
      itensInseridos = (ins ?? []) as typeof itensInseridos;
      gravados = rows.length;
    }

    const { error: upErr } = await db
      .from("documentos")
      .update({ itens_status: body.status, itens_extraido_em: agora })
      .eq("id", body.documento_id);
    if (upErr) {
      throw new Error(`falha ao atualizar status do documento: ${upErr.message}`);
    }

    return jsonResponse(
      {
        documento_id: body.documento_id,
        status: body.status,
        itens_gravados: gravados,
        itens: itensInseridos,
      },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
