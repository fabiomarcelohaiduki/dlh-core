// =====================================================================
// Edge Function: relacionamentos-tipos-no  (Relacionamentos GraphLink)
//
// GESTAO HUMANA dos tipos de no (config_tipos_no) POR ORG. O mapeamento
// tipo -> tabela do substrato (tabela_fonte) e DADO, nao hardcode: com ele
// os dropdowns de campo das regras humanas listam as colunas REAIS da
// tabela (RPC relacionamentos_tipos_campos) e uma fonte nova pode ser
// cadastrada pelo cockpit sem mexer em codigo.
//
// Rotas:
//   GET /relacionamentos-tipos-no          { tipos: [{ tipo, label, icone,
//                                            cor, ordem, ativo, tabela_fonte,
//                                            campos: [{ campo, tipo_dado }] }] }
//                                          (1 roundtrip alimenta o RegraForm)
//   POST /relacionamentos-tipos-no         cria tipo novo { tipo, label,
//                                          tabela_fonte, icone?, cor? };
//                                          tabela sem coluna utilizavel -> 422
//   PUT /relacionamentos-tipos-no/:tipo    edita { label?, tabela_fonte?,
//                                          ativo? } (mesma validacao de tabela)
//
// SEGURANCA: requireAuthorizedUser (allowlist humana) + org_id SEMPRE do JWT
// (resolverOrgIdUsuario), nunca do body. Escritas auditadas via
// logSensitiveAction (best-effort, nunca derruba a escrita).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { routeSegments } from "../_shared/rest.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";
import {
  parseJsonBody,
  relacionamentosTipoNoCreateSchema,
  relacionamentosTipoNoUpdateSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-tipos-no";

// Colunas expostas nas respostas (consumo do RegraForm + editor de tipos).
const TIPO_COLUMNS = "tipo, label, icone, cor, ordem, ativo, tabela_fonte";

// Formato do identificador de tipo na rota (espelha o schema zod).
const TIPO_SEGMENT_RE = /^[a-z][a-z0-9_]*$/;

type ServiceClient = ReturnType<typeof createServiceClient>;

interface TipoNoRow {
  tipo: string;
  label: string;
  icone: string;
  cor: string | null;
  ordem: number;
  ativo: boolean;
  tabela_fonte: string | null;
}

interface CampoTabela {
  campo: string;
  tipo_dado: string;
}

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

/**
 * Colunas utilizaveis de UMA tabela do public (RPC relacionamentos_campos_tabela).
 * Resultado vazio significa tabela inexistente ou sem coluna que sirva como
 * chave de match.
 */
async function camposDaTabela(db: ServiceClient, tabela: string): Promise<CampoTabela[]> {
  const { data, error } = await db.rpc("relacionamentos_campos_tabela", { p_tabela: tabela });
  if (error) {
    throw new HttpError(500, "tipos_no_campos_failed", "falha ao consultar as colunas da tabela");
  }
  return (data ?? []) as CampoTabela[];
}

/**
 * Garante que a tabela_fonte existe no schema public e tem ao menos uma
 * coluna utilizavel. 422 caso contrario (tabela invalida para regra).
 */
async function assertTabelaFonteValida(
  db: ServiceClient,
  tabela: string,
): Promise<CampoTabela[]> {
  const campos = await camposDaTabela(db, tabela);
  if (campos.length === 0) {
    throw new HttpError(
      422,
      "tabela_fonte_invalida",
      `tabela "${tabela}" inexistente no schema public ou sem coluna utilizavel para regras`,
    );
  }
  return campos;
}

/** Rele 1 tipo da org (fonte da resposta pos-escrita). */
async function fetchTipo(
  db: ServiceClient,
  orgId: string,
  tipo: string,
): Promise<TipoNoRow | null> {
  const { data, error } = await db
    .from("config_tipos_no")
    .select(TIPO_COLUMNS)
    .eq("org_id", orgId)
    .eq("tipo", tipo)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "tipos_no_query_failed", "falha ao consultar o tipo de no");
  }
  return (data as TipoNoRow | null) ?? null;
}

// ---------------------------------------------------------------------
// GET: tipos da org + campos reais de cada tabela_fonte (1 roundtrip).
// ---------------------------------------------------------------------
async function listTipos(orgId: string): Promise<Response> {
  const db = createServiceClient();

  const [tiposRes, camposRes] = await Promise.all([
    db
      .from("config_tipos_no")
      .select(TIPO_COLUMNS)
      .eq("org_id", orgId)
      .order("ordem", { ascending: true })
      .order("created_at", { ascending: true }),
    db.rpc("relacionamentos_tipos_campos", { p_org_id: orgId }),
  ]);

  if (tiposRes.error) {
    throw new HttpError(500, "tipos_no_query_failed", "falha ao listar os tipos de no");
  }
  if (camposRes.error) {
    throw new HttpError(500, "tipos_no_campos_failed", "falha ao consultar os campos por tipo");
  }

  // Agrupa os campos (tipo, campo, tipo_dado) por tipo.
  const camposPorTipo = new Map<string, CampoTabela[]>();
  for (const row of (camposRes.data ?? []) as Array<CampoTabela & { tipo: string }>) {
    const lista = camposPorTipo.get(row.tipo) ?? [];
    lista.push({ campo: row.campo, tipo_dado: row.tipo_dado });
    camposPorTipo.set(row.tipo, lista);
  }

  const tipos = ((tiposRes.data ?? []) as TipoNoRow[]).map((t) => ({
    ...t,
    campos: camposPorTipo.get(t.tipo) ?? [],
  }));

  return jsonResponse({ tipos }, 200);
}

// ---------------------------------------------------------------------
// POST: cria tipo novo (tabela_fonte validada contra o schema real).
// ---------------------------------------------------------------------
async function createTipo(req: Request, orgId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, relacionamentosTipoNoCreateSchema);
  const db = createServiceClient();

  const campos = await assertTabelaFonteValida(db, input.tabela_fonte);

  // Proximo slot de ordenacao da org (tipos novos entram no fim da lista).
  const { data: ultimo, error: ordemError } = await db
    .from("config_tipos_no")
    .select("ordem")
    .eq("org_id", orgId)
    .order("ordem", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ordemError) {
    throw new HttpError(500, "tipos_no_query_failed", "falha ao calcular a ordem do tipo");
  }
  const ordem = ((ultimo?.ordem as number | undefined) ?? 0) + 1;

  const payload = {
    org_id: orgId,
    tipo: input.tipo,
    label: input.label,
    icone: input.icone ?? "circle",
    cor: input.cor ?? null,
    ordem,
    ativo: true,
    tabela_fonte: input.tabela_fonte,
  };

  const { data, error } = await db
    .from("config_tipos_no")
    .insert(payload)
    .select(TIPO_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new HttpError(409, "tipo_duplicado", `o tipo "${input.tipo}" ja existe nesta org`);
    }
    throw new HttpError(500, "tipos_no_mutation_failed", "falha ao criar o tipo de no");
  }

  await logSensitiveAction({
    tabela: "config_tipos_no",
    acao: "relacionamentos_tipo_no_criar",
    registroId: `${orgId}:${input.tipo}`,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse({ ...(data as TipoNoRow), campos }, 201);
}

// ---------------------------------------------------------------------
// PUT /:tipo — edita label / tabela_fonte / ativo.
// ---------------------------------------------------------------------
async function updateTipo(
  req: Request,
  tipo: string,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, relacionamentosTipoNoUpdateSchema);
  const db = createServiceClient();

  const previous = await fetchTipo(db, orgId, tipo);
  if (!previous) {
    throw new HttpError(404, "nao_encontrado", "tipo de no nao encontrado");
  }

  // tabela_fonte nova precisa existir e ter coluna utilizavel.
  if (input.tabela_fonte !== undefined) {
    await assertTabelaFonteValida(db, input.tabela_fonte);
  }

  const payload: Record<string, unknown> = {};
  if (input.label !== undefined) payload.label = input.label;
  if (input.tabela_fonte !== undefined) payload.tabela_fonte = input.tabela_fonte;
  if (input.ativo !== undefined) payload.ativo = input.ativo;

  const { data, error } = await db
    .from("config_tipos_no")
    .update(payload)
    .eq("org_id", orgId)
    .eq("tipo", tipo)
    .select(TIPO_COLUMNS)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "tipos_no_mutation_failed", "falha ao atualizar o tipo de no");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "tipo de no nao encontrado");
  }

  const atualizado = data as TipoNoRow;

  // Acao de auditoria distingue o toggle de ativo do patch comum.
  let acao = "relacionamentos_tipo_no_editar";
  if (typeof input.ativo === "boolean" && input.ativo !== previous.ativo) {
    acao = input.ativo ? "relacionamentos_tipo_no_ativar" : "relacionamentos_tipo_no_desativar";
  }

  await logSensitiveAction({
    tabela: "config_tipos_no",
    acao,
    registroId: `${orgId}:${tipo}`,
    usuario: email,
    dadosAnteriores: {
      label: previous.label,
      tabela_fonte: previous.tabela_fonte,
      ativo: previous.ativo,
    },
    dadosNovos: payload,
  });

  const campos = atualizado.tabela_fonte
    ? await camposDaTabela(db, atualizado.tabela_fonte)
    : [];

  return jsonResponse({ ...atualizado, campos }, 200);
}

// ---------------------------------------------------------------------
// Roteamento.
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "POST", "PUT"]);

    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();
    const orgId = await resolverOrgIdUsuario(db, ctx.user.id);

    const segments = routeSegments(req, FUNCTION_SEGMENT);
    const tipoRaw = segments[0];

    if (tipoRaw === undefined) {
      if (req.method === "GET") return await listTipos(orgId);
      if (req.method === "POST") return await createTipo(req, orgId, ctx.email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
    }

    if (!TIPO_SEGMENT_RE.test(tipoRaw)) {
      throw new HttpError(400, "validation_error", "identificador de tipo invalido na rota");
    }
    if (req.method === "PUT") return await updateTipo(req, tipoRaw, orgId, ctx.email);
    throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use PUT");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
