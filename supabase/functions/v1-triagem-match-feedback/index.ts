// =====================================================================
// Edge Function: v1-triagem-match-feedback  (cockpit - feedback de match)
//   -> POST /v1-triagem-match-feedback   grava/atualiza a correcao do match
//   -> GET  /v1-triagem-match-feedback?status=pendente   lista a fila
//
// Canal de APRENDIZADO do match item x produto/SKU (triagem_match_feedback).
// O humano corrige o match na tela; a correcao vira fila para curadoria
// posterior (promover para cotacao_regras ou metodo, fora deste Edge).
//
// DOIS efeitos por chamada:
//   1) grava na FILA (triagem_match_feedback) -> aprendizado, curadoria humana.
//   2) aplica AO VIVO em triagem_item_matches -> a tela reflete a edicao na hora
//      (a edicao e DECISAO DIRETA do humano no cockpit, nao acao automatica da
//      IA -> nao fere o SOM). Atencao: uma re-triagem do aviso regrava os
//      matches (delete-then-insert) e pode reverter; por isso a fila/curadoria
//      ainda importa (corrige a raiz para o subagente nao repetir o erro).
//
// 3 acoes:
//   'corrigir'  -> produto e/ou SKU errados (produto_correto obrigatorio)
//   'remover'   -> match indevido / falso positivo (sem correto)
//   'adicionar' -> item sem match que deveria ter (produto_correto obrigatorio)
//
// Upsert por (aviso_id, documento_item_id): re-corrigir sobrescreve a linha
// vigente, sem duplicar. autor = usuario logado (ctx.email).
//
// Autorizacao na borda (US-21): requireAuthorizedUser -> 401/403. Escrita com
// service_role (tabela de triagem fora das views lia.*, SEC-3). Acao auditada.
// =====================================================================

import { z } from "zod";
import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { parseJsonBody } from "../_shared/validation.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

const FUNCTION_SEGMENT = "v1-triagem-match-feedback";

// ---------------------------------------------------------------------
// Validacao do corpo (zod). Coerencia acao x correto espelha a CHECK do banco.
// ---------------------------------------------------------------------

const matchFeedbackBodySchema = z
  .object({
    aviso_id: z.string().uuid("aviso_id deve ser um uuid valido"),
    documento_item_id: z.string().uuid("documento_item_id deve ser um uuid valido"),
    acao: z.enum(["corrigir", "remover", "adicionar"]),
    item_descricao: z.string().nullish(),
    produto_sugerido_id: z.string().uuid().nullish(),
    sku_sugerido_id: z.string().uuid().nullish(),
    produto_sugerido_nome: z.string().nullish(),
    produto_correto_id: z.string().uuid().nullish(),
    sku_correto_id: z.string().uuid().nullish(),
    motivo: z.string().trim().min(1, "motivo e obrigatorio"),
  })
  .superRefine((val, ctx) => {
    if (val.acao === "remover") {
      if (val.produto_correto_id || val.sku_correto_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["produto_correto_id"],
          message: "acao 'remover' nao leva produto/SKU correto",
        });
      }
    } else if (!val.produto_correto_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["produto_correto_id"],
        message: `acao '${val.acao}' exige produto_correto_id`,
      });
    }
  });

type MatchFeedbackBody = z.infer<typeof matchFeedbackBodySchema>;

interface FeedbackRow {
  id: string;
  aviso_id: string;
  documento_item_id: string;
  item_descricao: string | null;
  acao: string;
  produto_sugerido_id: string | null;
  sku_sugerido_id: string | null;
  produto_sugerido_nome: string | null;
  produto_correto_id: string | null;
  sku_correto_id: string | null;
  motivo: string;
  status: string;
  autor: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------
// POST — grava/atualiza a correcao (upsert por aviso+item).
// ---------------------------------------------------------------------

async function postHandler(req: Request): Promise<Response> {
  const ctx = await requireAuthorizedUser(req);
  const body: MatchFeedbackBody = await parseJsonBody(req, matchFeedbackBodySchema);
  const db = createServiceClient();

  const linha = {
    aviso_id: body.aviso_id,
    documento_item_id: body.documento_item_id,
    item_descricao: body.item_descricao ?? null,
    acao: body.acao,
    produto_sugerido_id: body.produto_sugerido_id ?? null,
    sku_sugerido_id: body.sku_sugerido_id ?? null,
    produto_sugerido_nome: body.produto_sugerido_nome ?? null,
    produto_correto_id: body.produto_correto_id ?? null,
    sku_correto_id: body.sku_correto_id ?? null,
    motivo: body.motivo,
    status: "pendente",
    autor: ctx.email,
    // Re-corrigir reabre a fila (curadoria anterior deixa de valer).
    curado_em: null,
    curado_destino: null,
  };

  const { data, error } = await db
    .from("triagem_match_feedback")
    .upsert(linha, { onConflict: "aviso_id,documento_item_id" })
    .select("id")
    .single();
  if (error) {
    throw new Error(`falha ao gravar feedback de match: ${error.message}`);
  }
  const id = (data as { id: string }).id;

  // Aplica o efeito ao vivo no match exibido pelo cockpit (triagem_item_matches).
  if (body.acao === "remover") {
    const { error: delErr } = await db
      .from("triagem_item_matches")
      .delete()
      .eq("aviso_id", body.aviso_id)
      .eq("documento_item_id", body.documento_item_id);
    if (delErr) throw new Error(`falha ao remover o match exibido: ${delErr.message}`);
  } else {
    // corrigir | adicionar -> grava/atualiza o match com o produto/SKU certos.
    // produto_nome e snapshot (resiliencia de exibicao) -> resolve do catalogo.
    let produtoNome: string | null = null;
    if (body.produto_correto_id) {
      const { data: prod } = await db
        .from("produtos")
        .select("nome")
        .eq("id", body.produto_correto_id)
        .single();
      produtoNome = (prod as { nome: string } | null)?.nome ?? null;
    }
    const { error: upErr } = await db.from("triagem_item_matches").upsert(
      {
        aviso_id: body.aviso_id,
        documento_item_id: body.documento_item_id,
        produto_id: body.produto_correto_id ?? null,
        sku_id: body.sku_correto_id ?? null,
        produto_nome: produtoNome,
        // Edicao humana nao tem score semantico de busca.
        score: null,
      },
      { onConflict: "aviso_id,documento_item_id" },
    );
    if (upErr) throw new Error(`falha ao aplicar o match exibido: ${upErr.message}`);
  }

  await logSensitiveAction({
    tabela: "triagem_match_feedback",
    acao: "match_feedback",
    registroId: body.aviso_id,
    usuario: ctx.email,
    dadosNovos: {
      id,
      documento_item_id: body.documento_item_id,
      acao: body.acao,
      produto_correto_id: body.produto_correto_id ?? null,
      sku_correto_id: body.sku_correto_id ?? null,
    },
  });

  return jsonResponse({ id, ok: true }, 200);
}

// ---------------------------------------------------------------------
// GET — lista a fila. ?status= filtra (default pendente). Resolve os nomes do
// produto correto e os codigos de SKU (sugerido + correto) para exibir sem join.
// ---------------------------------------------------------------------

const statusEnum = z.enum(["pendente", "promovido", "descartado"]);

async function getHandler(req: Request): Promise<Response> {
  await requireAuthorizedUser(req);
  const db = createServiceClient();

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? statusEnum.parse(statusParam) : "pendente";

  const { data, error } = await db
    .from("triagem_match_feedback")
    .select(
      "id, aviso_id, documento_item_id, item_descricao, acao, produto_sugerido_id, sku_sugerido_id, produto_sugerido_nome, produto_correto_id, sku_correto_id, motivo, status, autor, created_at",
    )
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    throw new Error(`falha ao listar a fila de feedback: ${error.message}`);
  }
  const rows = (data ?? []) as FeedbackRow[];

  // Resolve nomes/codigos para exibicao (sem join no select).
  const produtoIds = [...new Set(rows.map((r) => r.produto_correto_id).filter(Boolean) as string[])];
  const skuIds = [
    ...new Set(
      rows.flatMap((r) => [r.sku_sugerido_id, r.sku_correto_id]).filter(Boolean) as string[],
    ),
  ];

  const produtoNome = new Map<string, string>();
  if (produtoIds.length > 0) {
    const { data: prods } = await db.from("produtos").select("id, nome").in("id", produtoIds);
    for (const p of (prods ?? []) as { id: string; nome: string }[]) produtoNome.set(p.id, p.nome);
  }
  const skuCodigo = new Map<string, string>();
  if (skuIds.length > 0) {
    const { data: skus } = await db
      .from("produto_skus")
      .select("id, codigo_sku")
      .in("id", skuIds);
    for (const s of (skus ?? []) as { id: string; codigo_sku: string }[]) {
      skuCodigo.set(s.id, s.codigo_sku);
    }
  }

  const itens = rows.map((r) => ({
    ...r,
    produto_correto_nome: r.produto_correto_id ? produtoNome.get(r.produto_correto_id) ?? null : null,
    sku_sugerido_codigo: r.sku_sugerido_id ? skuCodigo.get(r.sku_sugerido_id) ?? null : null,
    sku_correto_codigo: r.sku_correto_id ? skuCodigo.get(r.sku_correto_id) ?? null : null,
  }));

  return jsonResponse({ itens }, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    if (req.method === "POST") return await postHandler(req);
    if (req.method === "GET") return await getHandler(req);
    throw new HttpError(405, "metodo_nao_permitido", "use GET ou POST");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
