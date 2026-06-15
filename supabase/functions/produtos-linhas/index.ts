// =====================================================================
// Edge Function: produtos-linhas  (Dominio A - cadastro/hierarquia)
// CRUD de produto_linhas (Linhas) + sub-rota /:id/atributos para o conjunto
// de atributos validos por Linha (produto_linha_atributos).
//
// Rotas:
//   GET    /produtos-linhas                      lista paginada (?ativo=&limit=&offset=)
//   POST   /produtos-linhas                      cria Linha (nome unico -> 409)
//   PUT    /produtos-linhas/:id                  atualiza Linha (incl. ativo)
//   DELETE /produtos-linhas/:id                  remove Linha (409 se ha produtos)
//   GET    /produtos-linhas/:id/atributos        lista atributos da Linha
//   POST   /produtos-linhas/:id/atributos        cria atributo (chave unica -> 409)
//   PUT    /produtos-linhas/:id/atributos/:aid   atualiza atributo
//   DELETE /produtos-linhas/:id/atributos/:aid   remove atributo
//
// Borda: handleCorsPreflight -> assertMethod -> requireAuthorizedUser ->
// validacao zod -> roteamento por metodo/sub-path. Escrita server-side via
// service_role (RLS deferida no schema de produtos; autorizacao na borda).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import {
  assertUuid,
  deleteRowById,
  isUniqueViolation,
  pickDefined,
  routeSegments,
} from "../_shared/rest.ts";
import {
  linhaAtributoCreateSchema,
  linhaAtributoUpdateSchema,
  parseBooleanFilter,
  parseJsonBody,
  parsePagination,
  produtoLinhaCreateSchema,
  produtoLinhaUpdateSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "produtos-linhas";
const LINHA_COLUMNS = "id, nome, descricao, ativo, created_at, updated_at";
const ATRIBUTO_COLUMNS =
  "id, linha_id, chave, tipo, obrigatorio, mostra_catalogo, mostra_ficha, created_at, updated_at";

// Bucket privado das imagens de Produto/SKU; TTL da URL assinada (1h).
const PRODUTOS_BUCKET = "produtos";
const FOTO_SIGNED_URL_TTL_SECONDS = 3600;

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * Foto representativa de cada Linha (reuso de imagem de Produto; sem coluna
 * propria na Linha). Pega o 1o Produto da Linha (por nome) que tem imagem e
 * usa a 1a foto dele (por ordem). Assina tudo num unico lote. Retorna
 * linha_id -> signed URL (ausencia = sem foto).
 */
async function resolverFotoLinhas(
  db: ServiceClient,
  linhaIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (linhaIds.length === 0) return out;

  const { data: produtos, error: prodErr } = await db
    .from("produtos")
    .select("id, linha_id, nome")
    .in("linha_id", linhaIds)
    .order("nome", { ascending: true });
  if (prodErr || !produtos || produtos.length === 0) return out;

  const produtoIds = produtos.map((p) => p.id as string);
  const { data: imagens, error: imgErr } = await db
    .from("produto_imagens")
    .select("produto_id, storage_path, ordem")
    .in("produto_id", produtoIds)
    .order("ordem", { ascending: true });
  if (imgErr || !imagens) return out;

  // 1a path por produto (ja ordenado por ordem).
  const pathPorProduto = new Map<string, string>();
  for (const r of imagens as Array<Record<string, unknown>>) {
    const pid = r.produto_id as string | null;
    const path = r.storage_path as string | null;
    if (pid && path && !pathPorProduto.has(pid)) pathPorProduto.set(pid, path);
  }

  // 1o produto (por nome) com foto, por Linha.
  const pathPorLinha = new Map<string, string>();
  for (const p of produtos) {
    const lid = p.linha_id as string;
    if (pathPorLinha.has(lid)) continue;
    const path = pathPorProduto.get(p.id as string);
    if (path) pathPorLinha.set(lid, path);
  }

  const paths = [...new Set(pathPorLinha.values())];
  if (paths.length === 0) return out;

  const signed = await db.storage
    .from(PRODUTOS_BUCKET)
    .createSignedUrls(paths, FOTO_SIGNED_URL_TTL_SECONDS);
  if (signed.error) return out;

  const urlPorPath = new Map<string, string>();
  for (const s of signed.data ?? []) {
    if (s.path && s.signedUrl) urlPorPath.set(s.path, s.signedUrl);
  }
  for (const [lid, path] of pathPorLinha) {
    const u = urlPorPath.get(path);
    if (u) out.set(lid, u);
  }
  return out;
}

/** Garante que a Linha existe antes de operar seus atributos. */
async function assertLinhaExists(db: ServiceClient, linhaId: string): Promise<void> {
  const { data, error } = await db
    .from("produto_linhas")
    .select("id")
    .eq("id", linhaId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "linha_query_failed", "falha ao consultar a Linha");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "Linha nao encontrada");
  }
}

// ---------------------------------------------------------------------
// Linhas
// ---------------------------------------------------------------------

async function listLinhas(req: Request): Promise<Response> {
  const db = createServiceClient();
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  const ativo = parseBooleanFilter(url.searchParams.get("ativo"));

  let query = db
    .from("produto_linhas")
    .select(LINHA_COLUMNS, { count: "exact" })
    .order("nome", { ascending: true })
    .range(offset, offset + limit - 1);

  if (ativo !== undefined) query = query.eq("ativo", ativo);

  const { data, count, error } = await query;
  if (error) {
    throw new HttpError(500, "linhas_query_failed", "falha ao listar as linhas");
  }

  const items = data ?? [];
  const fotoPorLinha = await resolverFotoLinhas(
    db,
    items.map((l) => l.id),
  );
  const itemsComFoto = items.map((l) => ({
    ...l,
    foto_url: fotoPorLinha.get(l.id) ?? null,
  }));

  return jsonResponse({ items: itemsComFoto, total: count ?? 0, limit, offset }, 200);
}

async function createLinha(req: Request, email: string): Promise<Response> {
  const input = await parseJsonBody(req, produtoLinhaCreateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["nome", "descricao", "ativo"]);

  const { data, error } = await db
    .from("produto_linhas")
    .insert(payload)
    .select(LINHA_COLUMNS)
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "linha_duplicada", "ja existe uma Linha com esse nome");
    }
    throw new HttpError(500, "linha_insert_failed", "falha ao criar a Linha");
  }

  await logSensitiveAction({
    tabela: "produto_linhas",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { nome: data.nome },
  });

  return jsonResponse(data, 201);
}

async function updateLinha(req: Request, linhaId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, produtoLinhaUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, ["nome", "descricao", "ativo"]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("produto_linhas")
    .update(payload)
    .eq("id", linhaId)
    .select(LINHA_COLUMNS)
    .maybeSingle();

  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "linha_duplicada", "ja existe uma Linha com esse nome");
    }
    throw new HttpError(500, "linha_update_failed", "falha ao atualizar a Linha");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "Linha nao encontrada");
  }

  await logSensitiveAction({
    tabela: "produto_linhas",
    acao: "atualizar",
    registroId: linhaId,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deleteLinha(linhaId: string, email: string): Promise<Response> {
  const db = createServiceClient();

  // Bloqueia exclusao quando ha produtos vinculados (FK ON DELETE RESTRICT).
  // Checagem explicita para devolver a mensagem de negocio exata (409).
  const { count, error: countError } = await db
    .from("produtos")
    .select("id", { count: "exact", head: true })
    .eq("linha_id", linhaId);
  if (countError) {
    throw new HttpError(500, "produtos_count_failed", "falha ao verificar produtos vinculados");
  }
  if ((count ?? 0) > 0) {
    throw new HttpError(409, "linha_com_produtos", "Linha possui produtos vinculados");
  }

  await deleteRowById(db, {
    table: "produto_linhas",
    id: linhaId,
    recurso: "Linha",
    errorCode: "linha_delete_failed",
  });

  await logSensitiveAction({
    tabela: "produto_linhas",
    acao: "remover",
    registroId: linhaId,
    usuario: email,
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// Atributos da Linha (/:id/atributos)
// ---------------------------------------------------------------------

async function listAtributos(linhaId: string): Promise<Response> {
  const db = createServiceClient();
  await assertLinhaExists(db, linhaId);

  const { data, error } = await db
    .from("produto_linha_atributos")
    .select(ATRIBUTO_COLUMNS)
    .eq("linha_id", linhaId)
    .order("chave", { ascending: true });

  if (error) {
    throw new HttpError(500, "atributos_query_failed", "falha ao listar os atributos da Linha");
  }

  return jsonResponse({ items: data ?? [] }, 200);
}

async function createAtributo(req: Request, linhaId: string, email: string): Promise<Response> {
  const input = await parseJsonBody(req, linhaAtributoCreateSchema);
  const db = createServiceClient();
  await assertLinhaExists(db, linhaId);

  const payload = {
    linha_id: linhaId,
    ...pickDefined(input, ["chave", "tipo", "obrigatorio", "mostra_catalogo", "mostra_ficha"]),
  };

  const { data, error } = await db
    .from("produto_linha_atributos")
    .insert(payload)
    .select(ATRIBUTO_COLUMNS)
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(
        409,
        "atributo_duplicado",
        "ja existe um atributo com essa chave na Linha",
      );
    }
    throw new HttpError(500, "atributo_insert_failed", "falha ao criar o atributo");
  }

  await logSensitiveAction({
    tabela: "produto_linha_atributos",
    acao: "criar",
    registroId: data.id,
    usuario: email,
    dadosNovos: { linha_id: linhaId, chave: data.chave, tipo: data.tipo },
  });

  return jsonResponse(data, 201);
}

async function updateAtributo(
  req: Request,
  linhaId: string,
  atributoId: string,
  email: string,
): Promise<Response> {
  const input = await parseJsonBody(req, linhaAtributoUpdateSchema);
  const db = createServiceClient();

  const payload = pickDefined(input, [
    "chave",
    "tipo",
    "obrigatorio",
    "mostra_catalogo",
    "mostra_ficha",
  ]);
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "validation_error", "nenhum campo para atualizar");
  }
  payload.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("produto_linha_atributos")
    .update(payload)
    .eq("id", atributoId)
    .eq("linha_id", linhaId)
    .select(ATRIBUTO_COLUMNS)
    .maybeSingle();

  if (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(
        409,
        "atributo_duplicado",
        "ja existe um atributo com essa chave na Linha",
      );
    }
    throw new HttpError(500, "atributo_update_failed", "falha ao atualizar o atributo");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "atributo nao encontrado");
  }

  await logSensitiveAction({
    tabela: "produto_linha_atributos",
    acao: "atualizar",
    registroId: atributoId,
    usuario: email,
    dadosNovos: payload,
  });

  return jsonResponse(data, 200);
}

async function deleteAtributo(
  linhaId: string,
  atributoId: string,
  email: string,
): Promise<Response> {
  const db = createServiceClient();

  await deleteRowById(db, {
    table: "produto_linha_atributos",
    id: atributoId,
    extraEq: { linha_id: linhaId },
    recurso: "atributo",
    errorCode: "atributo_delete_failed",
  });

  await logSensitiveAction({
    tabela: "produto_linha_atributos",
    acao: "remover",
    registroId: atributoId,
    usuario: email,
    dadosAnteriores: { linha_id: linhaId },
  });

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, ["GET", "POST", "PUT", "DELETE"]);

    // Autorizacao na borda (401 sem sessao, 403 fora da allowlist).
    const { email } = await requireAuthorizedUser(req);

    const segments = routeSegments(req, FUNCTION_SEGMENT);
    // segments: [] | [id] | [id, "atributos"] | [id, "atributos", aid]
    const linhaIdRaw = segments[0];
    const isAtributos = segments[1] === "atributos";
    const atributoIdRaw = segments[2];

    // Sub-rota de atributos.
    if (isAtributos) {
      const linhaId = assertUuid(linhaIdRaw, "Linha");
      if (atributoIdRaw === undefined) {
        if (req.method === "GET") return await listAtributos(linhaId);
        if (req.method === "POST") return await createAtributo(req, linhaId, email);
        throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
      }
      const atributoId = assertUuid(atributoIdRaw, "atributo");
      if (req.method === "PUT") return await updateAtributo(req, linhaId, atributoId, email);
      if (req.method === "DELETE") return await deleteAtributo(linhaId, atributoId, email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use PUT ou DELETE");
    }

    // Rota de Linhas.
    if (linhaIdRaw === undefined) {
      if (req.method === "GET") return await listLinhas(req);
      if (req.method === "POST") return await createLinha(req, email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
    }

    const linhaId = assertUuid(linhaIdRaw, "Linha");
    if (req.method === "PUT") return await updateLinha(req, linhaId, email);
    if (req.method === "DELETE") return await deleteLinha(linhaId, email);
    throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use PUT ou DELETE");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
