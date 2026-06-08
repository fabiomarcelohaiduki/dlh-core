// =====================================================================
// Edge Function: documentos-descobrir  ->  POST /documentos/descobrir
// DESCOBERTA da camada 1: enfileira documento_vinculos (status='pendente')
// a partir dos anexos ja presentes em nomus_processos. Acionavel pelo
// cockpit (botao "Descobrir anexos") OU por sistema (cron/workflow).
//
//   A logica pesada (varrer payload + INSERT...SELECT...ON CONFLICT) mora
//   numa FUNCAO SQL (descobrir_vinculos_nomus); este Edge so autentica,
//   valida os parametros administraveis e chama a RPC com service_role.
//   Nao baixa bytes, nao chama Tika, nao usa LLM — so materializa a fila
//   que o runner do Actions consome depois (action='pendentes').
//
//   Idempotente: rodar de novo nao duplica (ON CONFLICT DO NOTHING na SQL).
//
//   AUTH (dual, espelha ingestao-coletar.resolveCaller):
//     - Bearer == service_role  -> chamador SISTEMA (cron/workflow), gatilho
//       'agendada'; usuario null.
//     - sessao humana autorizada -> chamador COCKPIT, gatilho 'manual';
//       usuario = e-mail.
//
//   ACOES (campo 'action' no body):
//     (default)  DESCOBRE e enfileira (escrita). Params abaixo.
//     'resumo'   LEITURA: contagens por status + lista dos anexos que
//                FALHARAM na extracao (nome, extensao, motivo, processo).
//                Contagens via service_role (regra do projeto: contagem
//                NUNCA por leitura direta do browser — RLS/grant fragil).
//
//   PARAMETROS de descoberta (body, todos opcionais):
//     fonte           'nomus' (unica fonte com descoberta hoje); default nomus.
//     tipo            filtra nomus_processos.tipo (ex.: 'Venda Governamental').
//     extensoes       allowlist normalizada (sem ponto): ['pdf','docx',...].
//     limiteProcessos teto de PROCESSOS varridos (id DESC); ausente = todos.
//
//   Toda escrita via service_role server-side (SEC-05). Acao auditada.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

const MAX_LIMITE_PROCESSOS = 100_000;
const MAX_ERROS_RESUMO = 200;
const STATUS_VINCULO = ["pendente", "extraido", "herdado", "erro"] as const;
type StatusVinculo = typeof STATUS_VINCULO[number];

type ServiceClient = ReturnType<typeof createServiceClient>;

interface DescobrirInput {
  fonte: "nomus";
  tipo: string | null;
  extensoes: string[] | null;
  limiteProcessos: number | null;
}

interface CallerContext {
  gatilho: "manual" | "agendada";
  usuario: string | null;
}

/**
 * Resolve o chamador: service_role (sistema/cron -> 'agendada') ou sessao
 * humana autorizada (cockpit -> 'manual'). Mesmo padrao de ingestao-coletar.
 */
async function resolveCaller(req: Request): Promise<CallerContext> {
  const token = extractBearerToken(req);
  const env = getEnv();
  if (token && token === env.serviceRoleKey) {
    return { gatilho: "agendada", usuario: null };
  }
  const { email } = await requireAuthorizedUser(req);
  return { gatilho: "manual", usuario: email };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    // Corpo vazio e valido: descobre tudo de nomus com os defaults.
    return {};
  }
}

function parseInput(o: Record<string, unknown>): DescobrirInput {
  const fonteRaw = typeof o.fonte === "string" ? o.fonte : "nomus";
  if (fonteRaw !== "nomus") {
    throw new HttpError(
      422,
      "fonte_nao_suportada",
      "descoberta disponivel apenas para a fonte 'nomus'",
    );
  }

  const tipo = typeof o.tipo === "string" && o.tipo.trim() !== "" ? o.tipo.trim() : null;

  let extensoes: string[] | null = null;
  if (Array.isArray(o.extensoes)) {
    const norm = o.extensoes
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
      .filter((e) => e.length > 0);
    extensoes = norm.length > 0 ? Array.from(new Set(norm)) : null;
  }

  let limiteProcessos: number | null = null;
  const lim = typeof o.limiteProcessos === "number" ? o.limiteProcessos : NaN;
  if (Number.isFinite(lim) && lim > 0) {
    limiteProcessos = Math.min(Math.floor(lim), MAX_LIMITE_PROCESSOS);
  }

  return { fonte: "nomus", tipo, extensoes, limiteProcessos };
}

// ---------------------------------------------------------------------
// action='resumo': contagens por status + anexos que falharam na extracao.
// Tudo via service_role (contagem confiavel; regra do projeto).
// ---------------------------------------------------------------------

function extensaoDoNome(nome: string | null): string | null {
  if (!nome) return null;
  const m = /\.([^.\\/]+)$/.exec(nome);
  return m ? m[1].toLowerCase() : null;
}

async function contarPorStatus(
  service: ServiceClient,
  status: StatusVinculo,
): Promise<number> {
  const { count, error } = await service
    .from("documento_vinculos")
    .select("id", { count: "exact", head: true })
    .eq("status_extracao", status);
  if (error) {
    throw new HttpError(500, "resumo_count_failed", "falha ao contar vinculos por status");
  }
  return count ?? 0;
}

async function montarResumo(service: ServiceClient): Promise<unknown> {
  const contagensArr = await Promise.all(
    STATUS_VINCULO.map((s) => contarPorStatus(service, s)),
  );
  const contagens: Record<string, number> = {};
  STATUS_VINCULO.forEach((s, i) => (contagens[s] = contagensArr[i]));
  contagens.total = contagensArr.reduce((a, b) => a + b, 0);

  const { data, error } = await service
    .from("documento_vinculos")
    .select("id, registro_origem_id, nome_anexo, erro, updated_at")
    .eq("status_extracao", "erro")
    .order("updated_at", { ascending: false })
    .limit(MAX_ERROS_RESUMO);
  if (error) {
    throw new HttpError(500, "resumo_erros_failed", "falha ao listar anexos com erro");
  }

  const erros = (data ?? []).map((r) => {
    const o = r as Record<string, unknown>;
    const nome = typeof o.nome_anexo === "string" ? o.nome_anexo : null;
    return {
      id: String(o.id),
      processoId: o.registro_origem_id ?? null,
      nomeAnexo: nome,
      extensao: extensaoDoNome(nome),
      erro: typeof o.erro === "string" ? o.erro : null,
      quando: o.updated_at ?? null,
    };
  });

  return { contagens, erros };
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    const caller = await resolveCaller(req);
    const body = await readBody(req);
    const service = createServiceClient();

    // LEITURA: resumo de status + erros (cockpit). Nao audita (sem efeito).
    if (body.action === "resumo") {
      return jsonResponse(await montarResumo(service), 200);
    }

    const input = parseInput(body);

    const { data, error } = await service.rpc("descobrir_vinculos_nomus", {
      p_tipo: input.tipo,
      p_extensoes: input.extensoes,
      p_limite_procs: input.limiteProcessos,
    });

    if (error) {
      throw new HttpError(500, "descoberta_falhou", "falha ao descobrir anexos pendentes");
    }

    const inseridos = typeof data === "number" ? data : Number(data ?? 0);

    await logSensitiveAction({
      tabela: "documento_vinculos",
      acao: "descobrir_anexos",
      usuario: caller.usuario,
      dadosNovos: {
        gatilho: caller.gatilho,
        fonte: input.fonte,
        tipo: input.tipo,
        extensoes: input.extensoes,
        limiteProcessos: input.limiteProcessos,
        inseridos,
      },
    });

    return jsonResponse({ fonte: input.fonte, inseridos }, 200);
  } catch (err) {
    return await errorResponse(err, { fn: "documentos-descobrir" });
  }
}

getEnv();

Deno.serve(handler);
