// =====================================================================
// Edge Function: produtos-imagens  (Dominio A - Imagens no Storage)
// Upload, listagem e remocao de fotos de Produto e/ou SKU no bucket PRIVADO
// 'produtos' (public=false). A validacao de tipo/tamanho/contagem acontece
// na borda ANTES de gravar no Storage (RNF-14); a escrita usa service_role
// (bypassa a RLS do Storage). A leitura devolve signed URL temporaria (1h).
//
// Rotas:
//   POST   /produtos-imagens                       upload (multipart/form-data)
//   GET    /produtos-imagens?produto_id=&sku_id=    lista com signed URL (TTL 1h)
//   DELETE /produtos-imagens/:id                    remove objeto + metadado
//
// Borda: handleCorsPreflight -> assertMethod -> requireAuthorizedUser ->
// validacao -> roteamento. Limites: 5MB/arquivo, MIME image/jpeg|png|webp,
// 10 fotos por Produto e 10 por SKU. Remover imagem NAO afeta o cadastro.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { assertUuid, deleteRowById, isUuid, routeSegments } from "../_shared/rest.ts";
import {
  IMAGEM_EXTENSAO,
  IMAGEM_MAX_BYTES,
  IMAGEM_MAX_POR_ALVO,
  IMAGEM_SIGNED_URL_TTL_SECONDS,
  imagemUploadMetaSchema,
  isImagemMimeAceito,
  parseWithSchema,
} from "../_shared/validation.ts";

const FUNCTION_SEGMENT = "produtos-imagens";
const BUCKET = "produtos";
const IMAGEM_COLUMNS =
  "id, produto_id, sku_id, storage_path, ordem, legenda, created_at, updated_at";

type ServiceClient = ReturnType<typeof createServiceClient>;

interface ImagemRow {
  id: string;
  produto_id: string | null;
  sku_id: string | null;
  storage_path: string;
  ordem: number;
  legenda: string | null;
  created_at: string;
  updated_at: string;
}

/** Le um campo de texto do form; "" (vazio) e tratado como ausente. */
function readField(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Garante que o alvo informado existe (Produto e/ou SKU). Alvo inexistente
 * vira 404 (evita objeto orfao e FK 23503 ao registrar o metadado).
 */
async function assertAlvoExiste(
  db: ServiceClient,
  produtoId: string | undefined,
  skuId: string | undefined,
): Promise<void> {
  if (produtoId) {
    const { data, error } = await db
      .from("produtos")
      .select("id")
      .eq("id", produtoId)
      .maybeSingle();
    if (error) {
      throw new HttpError(500, "produto_query_failed", "falha ao consultar o Produto");
    }
    if (!data) {
      throw new HttpError(404, "nao_encontrado", "Produto nao encontrado");
    }
  }
  if (skuId) {
    const { data, error } = await db
      .from("produto_skus")
      .select("id")
      .eq("id", skuId)
      .maybeSingle();
    if (error) {
      throw new HttpError(500, "sku_query_failed", "falha ao consultar o SKU");
    }
    if (!data) {
      throw new HttpError(404, "nao_encontrado", "SKU nao encontrado");
    }
  }
}

/** Conta fotos ja existentes de um alvo (filtro por coluna). */
async function contarFotos(
  db: ServiceClient,
  coluna: "produto_id" | "sku_id",
  valor: string,
): Promise<number> {
  const { count, error } = await db
    .from("produto_imagens")
    .select("id", { count: "exact", head: true })
    .eq(coluna, valor);
  if (error) {
    throw new HttpError(500, "imagens_count_failed", "falha ao verificar a contagem de fotos");
  }
  return count ?? 0;
}

/** Bloqueia o upload quando o alvo ja atingiu o maximo de fotos (RNF-14). */
async function assertContagemDisponivel(
  db: ServiceClient,
  produtoId: string | undefined,
  skuId: string | undefined,
): Promise<void> {
  if (produtoId && (await contarFotos(db, "produto_id", produtoId)) >= IMAGEM_MAX_POR_ALVO) {
    throw new HttpError(
      400,
      "limite_fotos_produto",
      `limite de ${IMAGEM_MAX_POR_ALVO} fotos por Produto atingido`,
    );
  }
  if (skuId && (await contarFotos(db, "sku_id", skuId)) >= IMAGEM_MAX_POR_ALVO) {
    throw new HttpError(
      400,
      "limite_fotos_sku",
      `limite de ${IMAGEM_MAX_POR_ALVO} fotos por SKU atingido`,
    );
  }
}

// ---------------------------------------------------------------------
// POST /produtos-imagens  (multipart/form-data)
// ---------------------------------------------------------------------

async function uploadImagem(req: Request, email: string): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "invalid_body", "envie um corpo multipart/form-data valido");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "validation_error", "o campo file (arquivo) e obrigatorio");
  }

  // Metadados do form ("" => ausente); ao menos um de produto_id/sku_id (refine).
  const meta = parseWithSchema(imagemUploadMetaSchema, {
    produto_id: readField(form, "produto_id"),
    sku_id: readField(form, "sku_id"),
    ordem: readField(form, "ordem"),
    legenda: readField(form, "legenda"),
  });

  // Validacao do binario ANTES de qualquer escrita no Storage (RNF-14).
  if (!isImagemMimeAceito(file.type)) {
    throw new HttpError(
      400,
      "tipo_invalido",
      "tipo de imagem invalido (use image/jpeg, image/png ou image/webp)",
    );
  }
  if (file.size > IMAGEM_MAX_BYTES) {
    throw new HttpError(400, "arquivo_grande", "arquivo excede o limite de 5MB");
  }

  const db = createServiceClient();
  await assertAlvoExiste(db, meta.produto_id, meta.sku_id);
  await assertContagemDisponivel(db, meta.produto_id, meta.sku_id);

  // Caminho do objeto: <prefixo do alvo>/<uuid>.<ext>. Prefixa pelo Produto
  // quando presente, senao pelo SKU (segrega objetos por alvo no bucket).
  const ext = IMAGEM_EXTENSAO[file.type];
  const prefix = meta.produto_id ? `produto/${meta.produto_id}` : `sku/${meta.sku_id}`;
  const storagePath = `${prefix}/${crypto.randomUUID()}.${ext}`;

  const upload = await db.storage.from(BUCKET).upload(storagePath, file, {
    contentType: file.type,
    upsert: false,
  });
  if (upload.error) {
    throw new HttpError(500, "upload_failed", "falha ao gravar a imagem no Storage");
  }

  const payload: Record<string, unknown> = { storage_path: storagePath };
  if (meta.produto_id) payload.produto_id = meta.produto_id;
  if (meta.sku_id) payload.sku_id = meta.sku_id;
  if (meta.ordem !== undefined) payload.ordem = meta.ordem;
  if (meta.legenda !== undefined) payload.legenda = meta.legenda;

  const { data, error } = await db
    .from("produto_imagens")
    .insert(payload)
    .select(IMAGEM_COLUMNS)
    .single();
  if (error) {
    // Rollback do objeto orfao: o metadado nao foi registrado.
    await db.storage.from(BUCKET).remove([storagePath]);
    throw new HttpError(500, "imagem_insert_failed", "falha ao registrar a imagem");
  }

  const row = data as ImagemRow;
  await logSensitiveAction({
    tabela: "produto_imagens",
    acao: "criar",
    registroId: row.id,
    usuario: email,
    dadosNovos: { produto_id: row.produto_id, sku_id: row.sku_id, storage_path: storagePath },
  });

  return jsonResponse(
    {
      id: row.id,
      produto_id: row.produto_id,
      sku_id: row.sku_id,
      storage_path: row.storage_path,
      ordem: row.ordem,
      legenda: row.legenda,
      created_at: row.created_at,
    },
    201,
  );
}

// ---------------------------------------------------------------------
// GET /produtos-imagens?produto_id=&sku_id=
// ---------------------------------------------------------------------

async function listImagens(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const produtoIdRaw = url.searchParams.get("produto_id");
  const skuIdRaw = url.searchParams.get("sku_id");

  if (produtoIdRaw !== null && !isUuid(produtoIdRaw)) {
    throw new HttpError(400, "validation_error", "produto_id deve ser UUID");
  }
  if (skuIdRaw !== null && !isUuid(skuIdRaw)) {
    throw new HttpError(400, "validation_error", "sku_id deve ser UUID");
  }

  const db = createServiceClient();
  let query = db
    .from("produto_imagens")
    .select(IMAGEM_COLUMNS)
    .order("ordem", { ascending: true })
    .order("created_at", { ascending: true });
  if (produtoIdRaw !== null) query = query.eq("produto_id", produtoIdRaw);
  if (skuIdRaw !== null) query = query.eq("sku_id", skuIdRaw);

  const { data, error } = await query;
  if (error) {
    throw new HttpError(500, "imagens_query_failed", "falha ao listar as imagens");
  }

  const rows = (data as ImagemRow[] | null) ?? [];

  // Signed URLs temporarias (TTL 1h) geradas em lote para os objetos listados.
  const signedByPath = new Map<string, string>();
  if (rows.length > 0) {
    const paths = rows.map((r) => r.storage_path);
    const signed = await db.storage.from(BUCKET).createSignedUrls(
      paths,
      IMAGEM_SIGNED_URL_TTL_SECONDS,
    );
    if (signed.error) {
      throw new HttpError(500, "signed_url_failed", "falha ao gerar as URLs assinadas");
    }
    for (const item of signed.data ?? []) {
      if (item.path && item.signedUrl) signedByPath.set(item.path, item.signedUrl);
    }
  }

  const items = rows.map((r) => ({
    id: r.id,
    produto_id: r.produto_id,
    sku_id: r.sku_id,
    storage_path: r.storage_path,
    signed_url: signedByPath.get(r.storage_path) ?? null,
    ordem: r.ordem,
    legenda: r.legenda,
  }));

  return jsonResponse({ items }, 200);
}

// ---------------------------------------------------------------------
// DELETE /produtos-imagens/:id
// Remove o objeto do Storage e o metadado; NAO altera o Produto/SKU.
// ---------------------------------------------------------------------

async function deleteImagem(imagemId: string, email: string): Promise<Response> {
  const db = createServiceClient();

  const { data, error } = await db
    .from("produto_imagens")
    .select("id, storage_path")
    .eq("id", imagemId)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "imagem_query_failed", "falha ao consultar a imagem");
  }
  if (!data) {
    throw new HttpError(404, "nao_encontrado", "imagem nao encontrada");
  }

  // Remove o objeto do Storage (idempotente: nao falha se ja ausente).
  const removed = await db.storage.from(BUCKET).remove([data.storage_path as string]);
  if (removed.error) {
    throw new HttpError(500, "storage_remove_failed", "falha ao remover o objeto do Storage");
  }

  await deleteRowById(db, {
    table: "produto_imagens",
    id: imagemId,
    recurso: "imagem",
    errorCode: "imagem_delete_failed",
  });

  await logSensitiveAction({
    tabela: "produto_imagens",
    acao: "remover",
    registroId: imagemId,
    usuario: email,
    dadosNovos: { storage_path: data.storage_path },
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
    assertMethod(req, ["GET", "POST", "DELETE"]);

    // Autorizacao na borda (401 sem sessao, 403 fora da allowlist).
    const { email } = await requireAuthorizedUser(req);

    const segments = routeSegments(req, FUNCTION_SEGMENT);

    // ----- Colecao: /produtos-imagens -----
    if (segments.length === 0) {
      if (req.method === "GET") return await listImagens(req);
      if (req.method === "POST") return await uploadImagem(req, email);
      throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use GET ou POST");
    }

    // ----- Item: /produtos-imagens/:id -----
    const imagemId = assertUuid(segments[0], "imagem");
    if (segments.length > 1) {
      throw new HttpError(404, "nao_encontrado", "rota nao encontrada");
    }
    if (req.method === "DELETE") return await deleteImagem(imagemId, email);
    throw new HttpError(405, "method_not_allowed", "metodo nao permitido: use DELETE");
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
