// =====================================================================
// Edge Function: drive-pastas  ->  POST /drive-pastas
// CRUD minimo das pastas do Google Drive cadastradas no cockpit (camada 1).
// Substitui o input manual DRIVE_FOLDER_ID do workflow: o cockpit cadastra
// pastas e o runner (descobrir-drive.mjs) le as ATIVAS daqui.
//
//   ACOES (campo 'action' no body):
//     'ativas'  LEITURA das pastas ativas (folder_id + nome). Chamada pelo
//               RUNNER do Actions (so tem anon + X-Cron-Secret) e tambem
//               aceita service_role/sessao humana. Read via service_role.
//     'salvar'  UPSERT por folder_id (normaliza URL->id). Sessao humana
//               autorizada + audit. Cria ou atualiza nome/ativo.
//     'remover' DELETE por id. Sessao humana autorizada + audit.
//
//   A LISTA COMPLETA do cockpit e hidratada server-side (RLS) na pagina
//   Fontes via createClient — nao ha leitura completa aqui (so 'ativas',
//   que o runner precisa). Escrita sempre via service_role + audit (SEC-05).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, matchesCronSecret, requireAuthorizedUser } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

const MAX_NOME = 200;

/**
 * Extrai o id da pasta de uma URL do Drive ou aceita o id cru. O usuario
 * normalmente cola o link inteiro (.../folders/<ID>); guardamos so o id.
 */
function normalizeFolderId(raw: string): string {
  const s = raw.trim();
  const porPath = /\/folders\/([a-zA-Z0-9_-]+)/.exec(s);
  if (porPath) return porPath[1];
  const porQuery = /[?&]id=([a-zA-Z0-9_-]+)/.exec(s);
  if (porQuery) return porQuery[1];
  return s;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** action='ativas' — pastas ativas para o runner varrer (system OU humano). */
async function handleAtivas(req: Request): Promise<Response> {
  const token = extractBearerToken(req);
  const env = getEnv();
  const ehSistema = (token && timingSafeEqual(token, env.serviceRoleKey)) ||
    (await matchesCronSecret(req));
  if (!ehSistema) {
    await requireAuthorizedUser(req); // cockpit tambem pode ler; nega anon
  }

  const service = createServiceClient();
  const { data, error } = await service
    .from("drive_pastas")
    .select("folder_id, nome")
    .eq("ativo", true)
    .order("created_at", { ascending: true });
  if (error) {
    throw new HttpError(500, "drive_pastas_query_failed", "falha ao listar pastas do Drive");
  }

  return jsonResponse({ pastas: data ?? [] }, 200);
}

/** action='salvar' — upsert por folder_id (cockpit). */
async function handleSalvar(req: Request, body: Record<string, unknown>): Promise<Response> {
  const { email } = await requireAuthorizedUser(req);

  const folderRaw = typeof body.folderId === "string" ? body.folderId : "";
  const folderId = normalizeFolderId(folderRaw);
  if (!folderId) {
    throw new HttpError(422, "folder_id_ausente", "informe o id ou o link da pasta do Drive");
  }
  const nome = typeof body.nome === "string" ? body.nome.trim().slice(0, MAX_NOME) : "";
  if (!nome) {
    throw new HttpError(422, "nome_ausente", "informe um nome para a pasta");
  }
  const ativo = typeof body.ativo === "boolean" ? body.ativo : true;

  const service = createServiceClient();
  const { data, error } = await service
    .from("drive_pastas")
    .upsert(
      { folder_id: folderId, nome, ativo, updated_at: new Date().toISOString() },
      { onConflict: "folder_id" },
    )
    .select("id")
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "drive_pastas_upsert_failed", "falha ao salvar a pasta do Drive");
  }

  await logSensitiveAction({
    tabela: "drive_pastas",
    acao: "salvar_pasta_drive",
    registroId: (data as { id: string } | null)?.id ?? null,
    usuario: email,
    dadosNovos: { folderId, nome, ativo },
  });

  return jsonResponse({ ok: true, folderId }, 200);
}

/** action='remover' — apaga uma pasta por id (cockpit). */
async function handleRemover(req: Request, body: Record<string, unknown>): Promise<Response> {
  const { email } = await requireAuthorizedUser(req);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    throw new HttpError(422, "id_ausente", "informe o id da pasta a remover");
  }

  const service = createServiceClient();
  const { error } = await service.from("drive_pastas").delete().eq("id", id);
  if (error) {
    throw new HttpError(500, "drive_pastas_delete_failed", "falha ao remover a pasta do Drive");
  }

  await logSensitiveAction({
    tabela: "drive_pastas",
    acao: "remover_pasta_drive",
    registroId: id,
    usuario: email,
    dadosNovos: { id },
  });

  return jsonResponse({ ok: true }, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    if (req.method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "use POST");
    }
    const body = await readBody(req);
    const action = typeof body.action === "string" ? body.action : "";

    switch (action) {
      case "ativas":
        return await handleAtivas(req);
      case "salvar":
        return await handleSalvar(req, body);
      case "remover":
        return await handleRemover(req, body);
      default:
        throw new HttpError(422, "acao_invalida", "action deve ser 'ativas', 'salvar' ou 'remover'");
    }
  } catch (err) {
    return await errorResponse(err, { fn: "drive-pastas" });
  }
}

getEnv();

Deno.serve(handler);
