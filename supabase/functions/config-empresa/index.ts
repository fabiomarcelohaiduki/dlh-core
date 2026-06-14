// =====================================================================
// Edge Function: config-empresa  ->  /config-empresa
// Le e persiste os dados institucionais da DLH (singleton config_empresa)
// usados no cabecalho/rodape da TABELA DE PRECOS em PDF.
//
//   GET  -> retorna a config atual (para popular a tela). Service client
//           (a leitura nao expoe segredo; os campos sao institucionais).
//   PUT  -> valida e persiste os campos (camelCase no body -> snake_case
//           na tabela). Exige sessao autorizada + audit. Singleton: ha 1
//           linha (seed na migration); atualiza essa linha, cria se faltar.
//
//   A logo vai como data URL base64 na coluna logo_base64 (sem bucket).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";
import { configEmpresaSchema, parseJsonBody } from "../_shared/validation.ts";

interface EmpresaRow {
  id: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  cnpj: string | null;
  inscricao_estadual: string | null;
  endereco: string | null;
  telefone: string | null;
  email: string | null;
  site: string | null;
  logo_base64: string | null;
  validade_padrao_dias: number | null;
  observacao_rodape: string | null;
}

const SELECT_COLS =
  "id, razao_social, nome_fantasia, cnpj, inscricao_estadual, endereco, telefone, email, site, logo_base64, validade_padrao_dias, observacao_rodape";

/** Mapeia a linha (snake_case) para o contrato camelCase do frontend. */
function toContract(row: EmpresaRow | null) {
  return {
    razaoSocial: row?.razao_social ?? null,
    nomeFantasia: row?.nome_fantasia ?? null,
    cnpj: row?.cnpj ?? null,
    inscricaoEstadual: row?.inscricao_estadual ?? null,
    endereco: row?.endereco ?? null,
    telefone: row?.telefone ?? null,
    email: row?.email ?? null,
    site: row?.site ?? null,
    logoBase64: row?.logo_base64 ?? null,
    validadePadraoDias: row?.validade_padrao_dias ?? 30,
    observacaoRodape: row?.observacao_rodape ?? null,
  };
}

/** "" / undefined -> null; strings reais sao mantidas. */
function texto(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

async function handleGet(): Promise<Response> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("config_empresa")
    .select(SELECT_COLS)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "config_empresa_query_failed", "falha ao consultar a config da empresa");
  }
  return jsonResponse(toContract(data as EmpresaRow | null), 200);
}

async function handlePut(req: Request): Promise<Response> {
  const { db, email } = await requireAuthorizedUser(req);
  const input = await parseJsonBody(req, configEmpresaSchema);

  const payload = {
    razao_social: texto(input.razaoSocial),
    nome_fantasia: texto(input.nomeFantasia),
    cnpj: texto(input.cnpj),
    inscricao_estadual: texto(input.inscricaoEstadual),
    endereco: texto(input.endereco),
    telefone: texto(input.telefone),
    email: texto(input.email),
    site: texto(input.site),
    logo_base64: texto(input.logoBase64),
    validade_padrao_dias: input.validadePadraoDias ?? 30,
    observacao_rodape: texto(input.observacaoRodape),
    updated_at: new Date().toISOString(),
  };

  // Singleton: atualiza a unica linha; cria se (por algum motivo) nao existir.
  const { data: existing, error: selErr } = await db
    .from("config_empresa")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "config_empresa_query_failed", "falha ao consultar a config da empresa");
  }

  if (existing?.id) {
    const { error: updErr } = await db
      .from("config_empresa")
      .update(payload)
      .eq("id", (existing as { id: string }).id);
    if (updErr) {
      throw new HttpError(500, "config_empresa_update_failed", "falha ao salvar a config da empresa");
    }
  } else {
    const { error: insErr } = await db.from("config_empresa").insert(payload);
    if (insErr) {
      throw new HttpError(500, "config_empresa_insert_failed", "falha ao criar a config da empresa");
    }
  }

  // Audit sem a logo (base64 grande/binario; registra apenas se mudou).
  await logSensitiveAction({
    tabela: "config_empresa",
    acao: "salvar_config_empresa",
    registroId: existing?.id ?? null,
    usuario: email,
    dadosNovos: {
      razaoSocial: payload.razao_social,
      nomeFantasia: payload.nome_fantasia,
      cnpj: payload.cnpj,
      inscricaoEstadual: payload.inscricao_estadual,
      endereco: payload.endereco,
      telefone: payload.telefone,
      email: payload.email,
      site: payload.site,
      logoDefinida: payload.logo_base64 != null,
      validadePadraoDias: payload.validade_padrao_dias,
      observacaoRodape: payload.observacao_rodape,
    },
  });

  return jsonResponse({ ok: true }, 200);
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    if (req.method === "GET") return await handleGet();
    if (req.method === "PUT") return await handlePut(req);
    throw new HttpError(405, "method_not_allowed", "use GET ou PUT");
  } catch (err) {
    return await errorResponse(err, { fn: "config-empresa" });
  }
}

getEnv();

Deno.serve(handler);
