// =====================================================================
// Edge Function: relacionamentos-abreviacoes  (Relacionamentos V2 - F4)
//
// GESTAO HUMANA das abreviacoes e cores semanticas por tipo de no
// (config_tipos_no.abreviacao_padrao / cor_semantica) POR ORG (SPEC §3.2.7):
//
//   GET   /relacionamentos-abreviacoes   { tipos: [{ tipo, abreviacao_padrao,
//                                          cor_semantica, cor? }] }  (read-only,
//                                          consumido pela legenda do grafo 3D)
//   PATCH /relacionamentos-abreviacoes   { itens: [{ tipo, abreviacao_padrao?,
//                                          cor_semantica? }] }  -> lote atomico
//                                          por org; 200 { tipos, alterados }
//
// SEGURANCA (SEC-D5 / RNF-15):
//   * requireAuthorizedUser garante allowlist humana (contas_autorizadas).
//     O papel MCP/IA (X-Service-Token) NAO possui sessao humana e cai em
//     401/403 na borda, sem acesso de escrita.
//   * org_id NUNCA vem do body: e resolvido pelo JWT (org_membership) e todas
//     as consultas/escritas sao escopadas por org_id (RLS current_user_orgs()).
//
// Atomicidade do lote: valida a existencia de TODOS os tipos na org antes de
// qualquer escrita (404 se algum inexistir) e aplica um unico UPSERT
// (onConflict org_id,tipo) carregando as colunas NOT NULL a partir dos valores
// atuais, de modo que ou tudo entra ou nada entra.
//
// Auditoria: logSensitiveAction por tipo efetivamente alterado
// (registro_id=<org_id>:<tipo>). Falha de auditoria nunca derruba a escrita.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { resolverOrgIdUsuario } from "../_shared/org.ts";
import { parseJsonBody, relacionamentosAbreviacoesPatchSchema } from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "relacionamentos-abreviacoes";

// Colunas expostas na resposta (legenda do grafo 3D).
const LEGENDA_COLUMNS = "tipo, abreviacao_padrao, cor_semantica, cor";
// Colunas necessarias para o UPSERT preservar as NOT NULL existentes.
const UPSERT_SOURCE_COLUMNS =
  "id, org_id, tipo, label, icone, cor, ordem, ativo, abreviacao_padrao, cor_semantica";

type ServiceClient = ReturnType<typeof createServiceClient>;

interface TipoRow {
  id: string;
  org_id: string;
  tipo: string;
  label: string;
  icone: string;
  cor: string | null;
  ordem: number;
  ativo: boolean;
  abreviacao_padrao: string | null;
  cor_semantica: string | null;
}

// ---------------------------------------------------------------------
// GET: lista as abreviacoes/cores por tipo da org (read-only).
// ---------------------------------------------------------------------
async function listAbreviacoes(orgId: string): Promise<Response> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("config_tipos_no")
    .select(LEGENDA_COLUMNS)
    .eq("org_id", orgId)
    .order("ordem", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    throw new HttpError(500, "abreviacoes_query_failed", "falha ao listar as abreviacoes por tipo");
  }
  return jsonResponse({ tipos: data ?? [] }, 200);
}

// ---------------------------------------------------------------------
// PATCH: atualiza em lote atomico por org.
// ---------------------------------------------------------------------
async function patchAbreviacoes(
  req: Request,
  orgId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, relacionamentosAbreviacoesPatchSchema);
  const db = createServiceClient();

  const tiposAlvo = input.itens.map((i) => i.tipo);

  // 1) Carrega os tipos alvo da org (fonte das colunas NOT NULL + previos).
  const { data: existentes, error: readError } = await db
    .from("config_tipos_no")
    .select(UPSERT_SOURCE_COLUMNS)
    .eq("org_id", orgId)
    .in("tipo", tiposAlvo);
  if (readError) {
    throw new HttpError(500, "abreviacoes_query_failed", "falha ao consultar os tipos da org");
  }

  const porTipo = new Map<string, TipoRow>();
  for (const row of (existentes ?? []) as TipoRow[]) {
    porTipo.set(row.tipo, row);
  }

  // 2) Valida existencia de TODOS os tipos ANTES de qualquer escrita (404).
  const inexistentes = tiposAlvo.filter((t) => !porTipo.has(t));
  if (inexistentes.length > 0) {
    throw new HttpError(
      404,
      "tipo_inexistente",
      `tipo(s) inexistente(s) para esta org: ${inexistentes.join(", ")}`,
    );
  }

  // 3) Monta as linhas do UPSERT preservando as NOT NULL existentes e
  //    determina quais tipos realmente mudam (para auditoria/alterados).
  const upsertRows: Record<string, unknown>[] = [];
  const alteracoes: Array<{
    tipo: string;
    anteriores: Record<string, unknown>;
    novos: Record<string, unknown>;
  }> = [];

  for (const item of input.itens) {
    const atual = porTipo.get(item.tipo)!;
    const novaAbrev = item.abreviacao_padrao ?? atual.abreviacao_padrao;
    const novaCor = item.cor_semantica ?? atual.cor_semantica;

    const mudou = novaAbrev !== atual.abreviacao_padrao || novaCor !== atual.cor_semantica;
    if (!mudou) continue;

    upsertRows.push({
      id: atual.id,
      org_id: orgId,
      tipo: atual.tipo,
      label: atual.label,
      icone: atual.icone,
      cor: atual.cor,
      ordem: atual.ordem,
      ativo: atual.ativo,
      abreviacao_padrao: novaAbrev,
      cor_semantica: novaCor,
    });

    const anteriores: Record<string, unknown> = {};
    const novos: Record<string, unknown> = {};
    if (item.abreviacao_padrao !== undefined) {
      anteriores.abreviacao_padrao = atual.abreviacao_padrao;
      novos.abreviacao_padrao = novaAbrev;
    }
    if (item.cor_semantica !== undefined) {
      anteriores.cor_semantica = atual.cor_semantica;
      novos.cor_semantica = novaCor;
    }
    alteracoes.push({ tipo: item.tipo, anteriores, novos });
  }

  // 4) Aplica o lote (um unico UPSERT). Nada a alterar -> devolve estado atual.
  if (upsertRows.length > 0) {
    const { error: upsertError } = await db
      .from("config_tipos_no")
      .upsert(upsertRows, { onConflict: "org_id,tipo" });
    if (upsertError) {
      if (upsertError.code === "23505") {
        throw new HttpError(
          409,
          "abreviacao_conflito",
          "conflito de unicidade ao salvar as abreviacoes",
        );
      }
      throw new HttpError(500, "abreviacoes_update_failed", "falha ao salvar as abreviacoes");
    }

    // 5) Auditoria por tipo alterado (best-effort, nunca derruba a escrita).
    await Promise.all(
      alteracoes.map((alt) =>
        logSensitiveAction({
          tabela: "config_tipos_no",
          acao: "edicao de abreviacao",
          registroId: `${orgId}:${alt.tipo}`,
          usuario: email,
          dadosAnteriores: alt.anteriores,
          dadosNovos: alt.novos,
        })
      ),
    );
  }

  // 6) Resposta: estado atualizado + tipos efetivamente alterados.
  const tipos = await fetchLegenda(db, orgId);
  return jsonResponse({ tipos, alterados: alteracoes.map((a) => a.tipo) }, 200);
}

async function fetchLegenda(db: ServiceClient, orgId: string): Promise<unknown[]> {
  const { data, error } = await db
    .from("config_tipos_no")
    .select(LEGENDA_COLUMNS)
    .eq("org_id", orgId)
    .order("ordem", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    throw new HttpError(500, "abreviacoes_query_failed", "falha ao reler as abreviacoes");
  }
  return data ?? [];
}

// ---------------------------------------------------------------------
// Roteamento.
// ---------------------------------------------------------------------
async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "PATCH"]);

    const ctx = await requireAuthorizedUser(req);
    const db = createServiceClient();
    const orgId = await resolverOrgIdUsuario(db, ctx.user.id);

    if (req.method === "GET") return await listAbreviacoes(orgId);
    return await patchAbreviacoes(req, orgId, ctx.email);
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
