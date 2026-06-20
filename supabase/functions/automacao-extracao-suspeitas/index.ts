// =====================================================================
// Edge Function: automacao-extracao-suspeitas  (cockpit - fila de extracao)
//   -> GET  /automacao-extracao-suspeitas?status=pendente   lista a fila
//   -> POST /automacao-extracao-suspeitas                   cura uma linha
//
// Consumidor humano da fila de revisao de EXTRACAO (documento_item_suspeitas),
// escrita pelo servidor (fidelidade per-documento em v1-documento-itens-gravar;
// recall_effecti per-aviso em v1-triagem-veredito). O humano CURA cada linha:
//   'confirmar' -> o item flagueado esta CORRETO (falso alarme) -> 'confirmado'
//   'corrigir'  -> informa o valor correto (descricao/numero) -> 'corrigido'
//   'descartar' -> suspeita sem acao / ruido -> 'descartado'
// Em qualquer caso a linha sai de 'pendente' e a v1-documento-itens-gravar NAO
// re-marca esse item como suspeito nas proximas re-extracoes (reaplicacao).
//
// Padrao SOM: a fila nao age sozinha; a curadoria e decisao DIRETA do humano no
// cockpit (nao acao automatica da IA).
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

const FUNCTION_SEGMENT = "automacao-extracao-suspeitas";

// ---------------------------------------------------------------------
// POST — cura uma linha da fila (por id). 'corrigir' exige um valor corrigido.
// ---------------------------------------------------------------------

const curarBodySchema = z
  .object({
    id: z.string().uuid("id deve ser um uuid valido"),
    acao: z.enum(["confirmar", "corrigir", "descartar"]),
    descricao_corrigida: z.string().max(20_000).nullish(),
    numero_corrigido: z.string().max(200).nullish(),
  })
  .superRefine((val, ctx) => {
    if (
      val.acao === "corrigir" &&
      !((val.descricao_corrigida ?? "").trim() || (val.numero_corrigido ?? "").trim())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["descricao_corrigida"],
        message: "acao 'corrigir' exige descricao_corrigida ou numero_corrigido",
      });
    }
  });

type CurarBody = z.infer<typeof curarBodySchema>;

const ACAO_PARA_STATUS: Record<CurarBody["acao"], string> = {
  confirmar: "confirmado",
  corrigir: "corrigido",
  descartar: "descartado",
};

interface SuspeitaRow {
  id: string;
  aviso_id: string | null;
  documento_id: string | null;
  documento_item_id: string | null;
  tipo: string;
  item_descricao: string | null;
  numero_suspeito: string | null;
  motivo: string;
  status: string;
  autor: string | null;
  descricao_corrigida: string | null;
  numero_corrigido: string | null;
  curado_por: string | null;
  curado_em: string | null;
  created_at: string;
}

async function postHandler(req: Request): Promise<Response> {
  const ctx = await requireAuthorizedUser(req);
  const body: CurarBody = await parseJsonBody(req, curarBodySchema);
  const db = createServiceClient();

  const patch: Record<string, unknown> = {
    status: ACAO_PARA_STATUS[body.acao],
    curado_por: ctx.email,
    curado_em: new Date().toISOString(),
    // 'corrigir' carrega o valor correto; as demais limpam (idempotencia ao
    // re-curar). O snapshot da descricao original (item_descricao) e preservado.
    descricao_corrigida: body.acao === "corrigir" ? (body.descricao_corrigida ?? null) : null,
    numero_corrigido: body.acao === "corrigir" ? (body.numero_corrigido ?? null) : null,
  };

  const { data, error } = await db
    .from("documento_item_suspeitas")
    .update(patch)
    .eq("id", body.id)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao curar a suspeita: ${error.message}`);
  }
  if (!data) {
    throw new HttpError(404, "suspeita_nao_encontrada", "suspeita inexistente");
  }

  await logSensitiveAction({
    tabela: "documento_item_suspeitas",
    acao: "extracao_suspeita_curar",
    registroId: body.id,
    usuario: ctx.email,
    dadosNovos: { acao: body.acao, status: patch.status },
  });

  return jsonResponse({ id: body.id, status: patch.status, ok: true }, 200);
}

// ---------------------------------------------------------------------
// GET — lista a fila. ?status= filtra (default pendente). Resolve o objeto do
// aviso (recall_effecti) e o nome do arquivo do documento (fidelidade) p/ exibir.
// ---------------------------------------------------------------------

const statusEnum = z.enum(["pendente", "confirmado", "corrigido", "descartado"]);

async function getHandler(req: Request): Promise<Response> {
  await requireAuthorizedUser(req);
  const db = createServiceClient();

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? statusEnum.parse(statusParam) : "pendente";

  const { data, error } = await db
    .from("documento_item_suspeitas")
    .select(
      "id, aviso_id, documento_id, documento_item_id, tipo, item_descricao, " +
        "numero_suspeito, motivo, status, autor, descricao_corrigida, " +
        "numero_corrigido, curado_por, curado_em, created_at",
    )
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    throw new Error(`falha ao listar a fila de suspeitas: ${error.message}`);
  }
  const rows = (data ?? []) as unknown as SuspeitaRow[];

  // Resolve contexto p/ exibir sem join: objeto do aviso + nome do documento.
  const avisoIds = [...new Set(rows.map((r) => r.aviso_id).filter(Boolean) as string[])];
  const docIds = [...new Set(rows.map((r) => r.documento_id).filter(Boolean) as string[])];

  const avisoObjeto = new Map<string, string | null>();
  if (avisoIds.length > 0) {
    const { data: avisos } = await db.from("avisos").select("id, objeto").in("id", avisoIds);
    for (const a of (avisos ?? []) as { id: string; objeto: string | null }[]) {
      avisoObjeto.set(a.id, a.objeto);
    }
  }
  const docNome = new Map<string, string | null>();
  if (docIds.length > 0) {
    const { data: docs } = await db
      .from("documentos")
      .select("id, nome_arquivo")
      .in("id", docIds);
    for (const d of (docs ?? []) as { id: string; nome_arquivo: string | null }[]) {
      docNome.set(d.id, d.nome_arquivo);
    }
  }

  const itens = rows.map((r) => ({
    ...r,
    aviso_objeto: r.aviso_id ? avisoObjeto.get(r.aviso_id) ?? null : null,
    documento_nome: r.documento_id ? docNome.get(r.documento_id) ?? null : null,
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
