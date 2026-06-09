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
//     fonte           'nomus' | 'effecti'; default 'nomus'. Cada fonte tem
//                     sua funcao SQL (nomus varre nomus_processos; effecti
//                     varre avisos) e seu adaptador no runner.
//     tipo            filtra nomus_processos.tipo (ex.: 'Venda Governamental').
//                     So aplica a 'nomus'; ignorado em 'effecti'.
//     extensoes       allowlist normalizada (sem ponto): ['pdf','docx',...].
//                     Em 'effecti' a ext e derivada do nome (ver caveat na
//                     migration); prefira null e deixe o Tika detectar.
//     limiteProcessos teto de REGISTROS varridos (procs ou avisos, mais novos
//                     primeiro); ausente = todos.
//
//   Toda escrita via service_role server-side (SEC-05). Acao auditada.
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { extractBearerToken, requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { getServiceSecret } from "../_shared/vault.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

const CRON_SECRET_NAME = "CRON_DISPATCH_SECRET" as const;
const MAX_LIMITE_PROCESSOS = 100_000;
const MAX_ERROS_RESUMO = 200;
const MAX_ARQUIVOS_DRIVE = 50_000;
const STATUS_VINCULO = ["pendente", "extraido", "herdado", "erro"] as const;
type StatusVinculo = typeof STATUS_VINCULO[number];

type ServiceClient = ReturnType<typeof createServiceClient>;

const FONTES_DESCOBRIVEIS = ["nomus", "effecti", "drive"] as const;
type FonteDescobrivel = typeof FONTES_DESCOBRIVEIS[number];

// Arquivo do Drive descoberto pelo runner (a lista vive na API do Google, nao
// no banco — por isso o runner lista e passa pronto; ver descobrir-drive.mjs).
interface ArquivoDrive {
  file_id: string;
  nome: string | null;
  mimeType: string | null;
  extensao: string | null;
  tamanho: number | null;
  assinatura: string | null;
}

interface DescobrirInput {
  fonte: FonteDescobrivel;
  tipo: string | null; // so aplica a 'nomus'; ignorado em 'effecti'
  extensoes: string[] | null;
  limiteProcessos: number | null; // teto de registros varridos (procs ou avisos)
}

interface CallerContext {
  gatilho: "manual" | "agendada";
  usuario: string | null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Resolve o chamador (mesma divisao de documentos-ingerir.assertInternalAuth):
 *   - Bearer == service_role        -> SISTEMA (cron/workflow), 'agendada'.
 *   - X-Cron-Secret == Vault secret  -> SISTEMA (runner do Actions, que NAO
 *     tem service_role, so o cron secret), 'agendada'. Sem este caminho o
 *     runner cai no requireAuthorizedUser e leva 401 (anon nao e sessao).
 *   - sessao humana autorizada       -> COCKPIT, 'manual', usuario = e-mail.
 */
async function resolveCaller(req: Request): Promise<CallerContext> {
  const token = extractBearerToken(req);
  const env = getEnv();
  if (token && token === env.serviceRoleKey) {
    return { gatilho: "agendada", usuario: null };
  }
  const provided = req.headers.get("X-Cron-Secret")?.trim() ?? "";
  const expected = (await getServiceSecret(CRON_SECRET_NAME))?.trim() ?? "";
  if (expected && provided && timingSafeEqual(provided, expected)) {
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
  if (!FONTES_DESCOBRIVEIS.includes(fonteRaw as FonteDescobrivel)) {
    throw new HttpError(
      422,
      "fonte_nao_suportada",
      `descoberta disponivel apenas para as fontes: ${FONTES_DESCOBRIVEIS.join(", ")}`,
    );
  }
  const fonte = fonteRaw as FonteDescobrivel;

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

  return { fonte, tipo, extensoes, limiteProcessos };
}

/**
 * Valida e normaliza a lista de arquivos do Drive vinda do runner. Diferente
 * de Nomus/Effecti (varredura SQL), a fonte da verdade aqui e a API do Google,
 * entao o runner ja entrega a lista; este Edge so persiste via RPC.
 */
function parseArquivosDrive(o: Record<string, unknown>): ArquivoDrive[] {
  if (!Array.isArray(o.arquivos)) {
    throw new HttpError(422, "arquivos_ausentes", "fonte 'drive' exige o campo 'arquivos' (array)");
  }
  if (o.arquivos.length > MAX_ARQUIVOS_DRIVE) {
    throw new HttpError(422, "arquivos_demais", `maximo de ${MAX_ARQUIVOS_DRIVE} arquivos por chamada`);
  }
  const out: ArquivoDrive[] = [];
  for (const raw of o.arquivos) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const fileId = typeof r.file_id === "string" ? r.file_id.trim() : "";
    if (!fileId) continue; // sem id natural = inobtenivel
    out.push({
      file_id: fileId,
      nome: typeof r.nome === "string" ? r.nome : null,
      mimeType: typeof r.mimeType === "string" ? r.mimeType : null,
      extensao: typeof r.extensao === "string" ? r.extensao : null,
      tamanho: typeof r.tamanho === "number" && Number.isFinite(r.tamanho) ? r.tamanho : null,
      assinatura: typeof r.assinatura === "string" ? r.assinatura : null,
    });
  }
  return out;
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

    // Cada fonte tem sua funcao SQL de descoberta (mesma fila, adaptador
    // proprio no runner). Nomus varre nomus_processos; Effecti varre avisos;
    // Drive recebe a lista pronta do runner (a verdade vive na API do Google).
    let data: unknown;
    let error: unknown;
    let arquivosRecebidos: number | null = null;

    if (input.fonte === "drive") {
      const arquivos = parseArquivosDrive(body);
      arquivosRecebidos = arquivos.length;
      ({ data, error } = await service.rpc("descobrir_vinculos_drive", {
        p_arquivos: arquivos,
      }));
    } else if (input.fonte === "effecti") {
      ({ data, error } = await service.rpc("descobrir_vinculos_effecti", {
        p_extensoes: input.extensoes,
        p_limite_avisos: input.limiteProcessos,
      }));
    } else {
      ({ data, error } = await service.rpc("descobrir_vinculos_nomus", {
        p_tipo: input.tipo,
        p_extensoes: input.extensoes,
        p_limite_procs: input.limiteProcessos,
      }));
    }

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
        arquivosRecebidos,
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
