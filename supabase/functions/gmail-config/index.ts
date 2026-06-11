// =====================================================================
// Edge Function: gmail-config  ->  POST /gmail-config
// Configuracao administravel da coleta Gmail (camada 1) + montagem da query.
// Espelha drive-pastas, mas as labels sao BLACKLIST (decisao Fabio 2026-06-09):
// cadastram-se labels a EXCLUIR, nao a incluir.
//
//   ACOES (campo 'action' no body):
//     'montar-query'  LEITURA: monta a(s) query(s) Gmail da JANELA INCREMENTAL
//                     de dois lados (decisao Fabio 2026-06-10). Devolve
//                     { queries: string[] } — 1 ou 2 entradas:
//                       - NOVOS  (sempre que ja houve coleta): after:<coletado_ate
//                         - 1 dia> -> pega so os e-mails que chegaram desde a
//                         ultima coleta (overlap de 1 dia; o dedup da fila
//                         absorve a repeticao da borda).
//                       - ANTIGOS (so se data_inicial < coletado_desde): backfill
//                         after:<data_inicial> before:<coletado_desde + 1 dia> ->
//                         busca o historico quando o usuario BAIXA a data.
//                       - 1a coleta (sem marcas): after:<data_inicial> (janela
//                         antiga). Cada query carrega os mesmos termos de
//                         blacklist (labels + categorias). Chamada pelo RUNNER do
//                         Actions (so tem anon + X-Cron-Secret); aceita
//                         service_role/sessao humana tambem. Read via service_role.
//     'salvar-config' UPDATE da data_inicial (singleton). Sessao humana + audit.
//     'salvar-label'  UPSERT de uma label da blacklist por 'label'. Sessao
//                     humana autorizada + audit. Cria ou atualiza nome/ativo.
//     'remover-label' DELETE de uma label por id. Sessao humana + audit.
//
//   A LISTA COMPLETA (data_inicial + labels) e hidratada server-side (RLS) na
//   pagina Fontes via createClient — sem leitura completa aqui (so o runner
//   precisa de 'montar-query'). Escrita sempre via service_role + audit (SEC-05).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, matchesCronSecret, requireAuthorizedUser } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

const MAX_NOME = 200;
const MAX_LABEL = 200;

// Slugs de categoria do Gmail aceitos na exclusao (as guias visiveis). O valor
// salvo em gmail_config.categorias_excluidas e o slug em ingles; vira
// -category:<slug> na query. Conjunto fechado: entrada fora dele e descartada.
const CATEGORIAS_VALIDAS = new Set(["promotions", "social", "updates", "forums"]);

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Garante que o caller e o sistema (runner/cron) ou uma sessao autorizada. */
async function exigirSistemaOuHumano(req: Request): Promise<void> {
  const token = extractBearerToken(req);
  const env = getEnv();
  const ehSistema = (token && timingSafeEqual(token, env.serviceRoleKey)) ||
    (await matchesCronSecret(req));
  if (!ehSistema) {
    await requireAuthorizedUser(req); // cockpit tambem pode montar a query; nega anon
  }
}

/** data 'YYYY-MM-DD' (Postgres) -> 'YYYY/MM/DD' (operador after:/before: do Gmail). */
function dataParaGmail(d: string): string {
  return d.slice(0, 10).replace(/-/g, "/");
}

/** Soma n dias a uma data 'YYYY-MM-DD' (em UTC), devolve 'YYYY-MM-DD'. */
function somarDias(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Categorias do Gmail (as guias "Promoções", "Social" etc.) NAO sao labels
// comuns: o operador -label:"Promoções" nao as exclui. O correto e
// -category:<slug>, com o slug FIXO em ingles. Mapeia os nomes PT/EN conhecidos
// para o slug; o que nao casa segue como label normal. Restrito as 4 guias
// EXCLUIVEIS (mesmas de CATEGORIAS_VALIDAS / da UI): 'primary' NAO entra de
// proposito — uma label "Principal" digitada nao pode virar -category:primary
// e excluir a caixa de entrada inteira da coleta em silencio.
const CATEGORIAS_GMAIL: Record<string, string> = {
  social: "social",
  promocoes: "promotions",
  promotions: "promotions",
  atualizacoes: "updates",
  updates: "updates",
  foruns: "forums",
  forums: "forums",
};

/** Normaliza um nome para casar com as categorias (sem acento, minusculo). */
function normalizarNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Converte um item da blacklist no operador de exclusao correto: categorias do
 * Gmail viram -category:<slug>; labels comuns viram -label:"nome" (aspas
 * escapadas).
 */
function termoBlacklist(nome: string): string {
  const slug = CATEGORIAS_GMAIL[normalizarNome(nome)];
  if (slug) return `-category:${slug}`;
  return `-label:"${nome.replace(/"/g, "")}"`;
}

/**
 * action='montar-query' — monta a(s) query(s) da janela incremental de dois
 * lados. Devolve { queries: string[] } (1 ou 2): NOVOS (sempre que ja houve
 * coleta) + ANTIGOS (backfill, so se o usuario baixou data_inicial). Cada query
 * leva os mesmos termos de blacklist (labels + categorias).
 */
async function handleMontarQuery(req: Request): Promise<Response> {
  await exigirSistemaOuHumano(req);
  const service = createServiceClient();

  const { data: cfg, error: cfgErr } = await service
    .from("gmail_config")
    .select("data_inicial, categorias_excluidas, coletado_ate, coletado_desde")
    .eq("id", true)
    .maybeSingle();
  if (cfgErr) {
    throw new HttpError(500, "gmail_config_query_failed", "falha ao ler a config do Gmail");
  }

  const { data: labels, error: lblErr } = await service
    .from("gmail_labels")
    .select("label")
    .eq("ativo", true)
    .order("created_at", { ascending: true });
  if (lblErr) {
    throw new HttpError(500, "gmail_labels_query_failed", "falha ao listar as labels do Gmail");
  }

  // Termos de blacklist (labels ativas + categorias) — comuns a toda query.
  const filtros: string[] = [];
  for (const l of labels ?? []) {
    const nome = (l as { label: string }).label?.trim();
    if (nome) filtros.push(termoBlacklist(nome));
  }
  const categorias = (cfg?.categorias_excluidas as string[] | null) ?? [];
  for (const slug of categorias) {
    if (CATEGORIAS_VALIDAS.has(slug)) filtros.push(`-category:${slug}`);
  }
  const sufixo = filtros.length ? ` ${filtros.join(" ")}` : "";

  // data_inicial e NOT NULL no schema (default '2026-05-01'); guarda mesmo assim.
  const dataInicial = ((cfg?.data_inicial as string | null) ?? "").slice(0, 10);
  const ate = ((cfg?.coletado_ate as string | null) ?? "").slice(0, 10) || null;
  const desde = ((cfg?.coletado_desde as string | null) ?? "").slice(0, 10) || null;

  const queries: string[] = [];
  if (!ate) {
    // Primeira coleta (nunca fechou com sucesso): janela antiga, tudo desde a data.
    const base = dataInicial ? `after:${dataParaGmail(dataInicial)}` : "";
    queries.push(`${base}${sufixo}`.trim());
  } else {
    // NOVOS: do ultimo ponto coberto, recuando 1 dia (overlap; dedup absorve).
    queries.push(`after:${dataParaGmail(somarDias(ate, -1))}${sufixo}`.trim());
    // ANTIGOS (backfill): so quando a data foi BAIXADA abaixo do ja coberto.
    const desdeEff = desde ?? dataInicial;
    if (dataInicial && desdeEff && dataInicial < desdeEff) {
      const janela =
        `after:${dataParaGmail(dataInicial)} before:${dataParaGmail(somarDias(desdeEff, 1))}`;
      queries.push(`${janela}${sufixo}`.trim());
    }
  }

  // 'query' (1a entrada) mantida para compat; o runner ja itera 'queries'.
  return jsonResponse({ queries, query: queries[0] ?? "" }, 200);
}

/** action='salvar-config' — atualiza a data_inicial (singleton). */
async function handleSalvarConfig(req: Request, body: Record<string, unknown>): Promise<Response> {
  const { email } = await requireAuthorizedUser(req);

  const dataRaw = typeof body.dataInicial === "string" ? body.dataInicial.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataRaw)) {
    throw new HttpError(422, "data_invalida", "dataInicial deve ser uma data ISO (YYYY-MM-DD)");
  }

  const service = createServiceClient();
  const { error } = await service
    .from("gmail_config")
    .upsert(
      { id: true, data_inicial: dataRaw, atualizado_em: new Date().toISOString() },
      { onConflict: "id" },
    );
  if (error) {
    throw new HttpError(500, "gmail_config_upsert_failed", "falha ao salvar a config do Gmail");
  }

  await logSensitiveAction({
    tabela: "gmail_config",
    acao: "salvar_config_gmail",
    usuario: email,
    dadosNovos: { dataInicial: dataRaw },
  });

  return jsonResponse({ ok: true, dataInicial: dataRaw }, 200);
}

/** action='salvar-categorias' — substitui a selecao de categorias a excluir. */
async function handleSalvarCategorias(req: Request, body: Record<string, unknown>): Promise<Response> {
  const { email } = await requireAuthorizedUser(req);

  const entrada = Array.isArray(body.categorias) ? body.categorias : [];
  const categorias = [
    ...new Set(
      entrada.filter((c): c is string => typeof c === "string" && CATEGORIAS_VALIDAS.has(c)),
    ),
  ];

  const service = createServiceClient();
  const { error } = await service
    .from("gmail_config")
    .upsert(
      { id: true, categorias_excluidas: categorias, atualizado_em: new Date().toISOString() },
      { onConflict: "id" },
    );
  if (error) {
    throw new HttpError(500, "gmail_config_categorias_failed", "falha ao salvar as categorias do Gmail");
  }

  await logSensitiveAction({
    tabela: "gmail_config",
    acao: "salvar_categorias_gmail",
    usuario: email,
    dadosNovos: { categorias },
  });

  return jsonResponse({ ok: true, categorias }, 200);
}

/** action='salvar-label' — upsert de uma label da blacklist por 'label'. */
async function handleSalvarLabel(req: Request, body: Record<string, unknown>): Promise<Response> {
  const { email } = await requireAuthorizedUser(req);

  const label = typeof body.label === "string" ? body.label.trim().slice(0, MAX_LABEL) : "";
  if (!label) {
    throw new HttpError(422, "label_ausente", "informe o nome da label a excluir");
  }
  const nome = typeof body.nome === "string" ? body.nome.trim().slice(0, MAX_NOME) : label;
  const ativo = typeof body.ativo === "boolean" ? body.ativo : true;

  const service = createServiceClient();
  const { data, error } = await service
    .from("gmail_labels")
    .upsert(
      { label, nome, ativo, updated_at: new Date().toISOString() },
      { onConflict: "label" },
    )
    .select("id")
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "gmail_labels_upsert_failed", "falha ao salvar a label do Gmail");
  }

  await logSensitiveAction({
    tabela: "gmail_labels",
    acao: "salvar_label_gmail",
    registroId: (data as { id: string } | null)?.id ?? null,
    usuario: email,
    dadosNovos: { label, nome, ativo },
  });

  return jsonResponse({ ok: true, label }, 200);
}

/** action='remover-label' — apaga uma label por id (cockpit). */
async function handleRemoverLabel(req: Request, body: Record<string, unknown>): Promise<Response> {
  const { email } = await requireAuthorizedUser(req);

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    throw new HttpError(422, "id_ausente", "informe o id da label a remover");
  }

  const service = createServiceClient();
  const { error } = await service.from("gmail_labels").delete().eq("id", id);
  if (error) {
    throw new HttpError(500, "gmail_labels_delete_failed", "falha ao remover a label do Gmail");
  }

  await logSensitiveAction({
    tabela: "gmail_labels",
    acao: "remover_label_gmail",
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
      case "montar-query":
        return await handleMontarQuery(req);
      case "salvar-config":
        return await handleSalvarConfig(req, body);
      case "salvar-categorias":
        return await handleSalvarCategorias(req, body);
      case "salvar-label":
        return await handleSalvarLabel(req, body);
      case "remover-label":
        return await handleRemoverLabel(req, body);
      default:
        throw new HttpError(
          422,
          "acao_invalida",
          "action deve ser 'montar-query', 'salvar-config', 'salvar-categorias', 'salvar-label' ou 'remover-label'",
        );
    }
  } catch (err) {
    return await errorResponse(err, { fn: "gmail-config" });
  }
}

getEnv();

Deno.serve(handler);
