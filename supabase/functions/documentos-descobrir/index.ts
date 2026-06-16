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
import { extractBearerToken, matchesCronSecret, requireAuthorizedUser } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { logSensitiveAction } from "../_shared/audit.ts";

const MAX_LIMITE_PROCESSOS = 100_000;
const MAX_ITENS_RESUMO = 200;
const MAX_ARQUIVOS_DRIVE = 50_000;
const STATUS_VINCULO = ["pendente", "extraido", "herdado", "erro", "precisa_ocr", "inobtenivel", "ignorado"] as const;
type StatusVinculo = typeof STATUS_VINCULO[number];

// Todos os status sao listaveis na tabela do cockpit (cada card e clicavel e
// filtra a lista por status). Cada status vem capado em MAX_ITENS_RESUMO p/ um
// volumoso (ex.: extraido) nao faminhar os demais — o card mostra o total real.
const STATUS_LISTAVEIS: StatusVinculo[] = [...STATUS_VINCULO];

type ServiceClient = ReturnType<typeof createServiceClient>;

const FONTES_DESCOBRIVEIS = ["nomus", "effecti", "drive", "gmail"] as const;
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

// Item do Gmail descoberto pelo runner (a lista de mensagens vive na API do
// Google, nao no banco; ver descobrir-gmail.mjs). Coleta por mensagem: cada
// email rende um item 'corpo' + N itens 'anexo', distinguidos por 'tipo'.
interface ItemGmail {
  message_id: string;
  thread_id: string | null;
  tipo: "corpo" | "anexo";
  nome: string;
  attachment_id: string | null;
  extensao: string | null;
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
  if (token && timingSafeEqual(token, env.serviceRoleKey)) {
    return { gatilho: "agendada", usuario: null };
  }
  if (await matchesCronSecret(req)) {
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

/**
 * Valida e normaliza a lista de itens do Gmail vinda do runner. Como o Drive,
 * a verdade vive na API do Google: o runner ja entrega os itens (corpo +
 * anexos por mensagem); este Edge so persiste via RPC.
 */
function parseItensGmail(o: Record<string, unknown>): ItemGmail[] {
  if (!Array.isArray(o.itens)) {
    throw new HttpError(422, "itens_ausentes", "fonte 'gmail' exige o campo 'itens' (array)");
  }
  if (o.itens.length > MAX_ARQUIVOS_DRIVE) {
    throw new HttpError(422, "itens_demais", `maximo de ${MAX_ARQUIVOS_DRIVE} itens por chamada`);
  }
  const out: ItemGmail[] = [];
  for (const raw of o.itens) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const messageId = typeof r.message_id === "string" ? r.message_id.trim() : "";
    const nome = typeof r.nome === "string" ? r.nome.trim() : "";
    if (!messageId || !nome) continue; // sem id natural ou nome = inenfileiravel
    const tipo = r.tipo === "corpo" ? "corpo" : "anexo";
    out.push({
      message_id: messageId,
      thread_id: typeof r.thread_id === "string" ? r.thread_id : null,
      tipo,
      nome,
      attachment_id: typeof r.attachment_id === "string" ? r.attachment_id : null,
      extensao: typeof r.extensao === "string" ? r.extensao : null,
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

/**
 * Link clicavel para abrir o anexo na origem, derivado de ref_obtencao por
 * fonte. Effecti ja guarda a URL publica; Drive/Gmail montam o link padrao do
 * Google a partir do id. Nomus nao tem URL publica (base64 no GET) => null.
 */
function linkDoVinculo(fonte: string, ref: unknown): string | null {
  const r = (ref && typeof ref === "object" ? ref : {}) as Record<string, unknown>;
  if (fonte === "effecti") {
    return typeof r.url === "string" && r.url ? r.url : null;
  }
  if (fonte === "drive") {
    const fileId = typeof r.file_id === "string" ? r.file_id : "";
    return fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
  }
  if (fonte === "gmail") {
    const threadId = typeof r.thread_id === "string" ? r.thread_id : "";
    return threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;
  }
  return null;
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

/** Lista ate MAX_ITENS_RESUMO vinculos de um status, mais recentes primeiro. */
async function listarPorStatus(
  service: ServiceClient,
  status: StatusVinculo,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from("documento_vinculos")
    .select("id, fonte, registro_origem_id, nome_anexo, ref_obtencao, erro, updated_at")
    .eq("status_extracao", status)
    .order("updated_at", { ascending: false })
    .limit(MAX_ITENS_RESUMO);
  if (error) {
    throw new HttpError(500, "resumo_itens_failed", "falha ao listar anexos por status");
  }
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function montarResumo(service: ServiceClient): Promise<unknown> {
  const contagensArr = await Promise.all(
    STATUS_VINCULO.map((s) => contarPorStatus(service, s)),
  );
  const contagens: Record<string, number> = {};
  STATUS_VINCULO.forEach((s, i) => (contagens[s] = contagensArr[i]));
  contagens.total = contagensArr.reduce((a, b) => a + b, 0);

  // Lista todos os status, cada um capado em MAX_ITENS_RESUMO p/ um nao faminhar
  // o outro. O cockpit filtra por status via card clicavel; o item carrega seu
  // proprio 'status'.
  const listas = await Promise.all(
    STATUS_LISTAVEIS.map((s) => listarPorStatus(service, s)),
  );
  const itens = listas.flatMap((linhas, i) => {
    const status = STATUS_LISTAVEIS[i];
    return linhas.map((r) => {
      const nome = typeof r.nome_anexo === "string" ? r.nome_anexo : null;
      const fonte = typeof r.fonte === "string" ? r.fonte : null;
      return {
        id: String(r.id),
        status,
        fonte,
        processoId: r.registro_origem_id ?? null,
        nomeAnexo: nome,
        extensao: extensaoDoNome(nome),
        // Link do ANEXO (arquivo na origem), derivado de ref_obtencao.
        url: fonte ? linkDoVinculo(fonte, r.ref_obtencao) : null,
        // Link do AVISO (pagina do processo no portal) — preenchido abaixo so
        // para Effecti, vindo de avisos.payload_bruto.url.
        avisoUrl: null as string | null,
        erro: typeof r.erro === "string" ? r.erro : null,
        quando: r.updated_at ?? null,
      };
    });
  });

  // Enriquece os itens Effecti com o link do AVISO na plataforma Effecti
  // (minha.effecti.com.br), distinto do link do ANEXO acima. O id do aviso na
  // Effecti = idLicitacao = registro_origem_id do vinculo, entao o link sai
  // direto do proprio item, sem consultar a tabela de avisos.
  for (const e of itens) {
    if (e.fonte === "effecti" && e.processoId != null) {
      e.avisoUrl = `https://minha.effecti.com.br/#/aviso-edital-minhas/${e.processoId}`;
    }
  }

  return { contagens, itens };
}

// ---------------------------------------------------------------------
// action='reprocessar-erros': re-enfileira os vinculos terminais
// (status_extracao -> 'pendente', limpa a msg de erro), opcionalmente
// filtrando por fonte. O status alvo e contextual ao card selecionado no
// cockpit: 'erro' (transitorios) ou 'inobtenivel' (inacessiveis). ESCRITA ->
// auditada. O runner do Actions so consome 'pendente', entao isto e o que faz
// um terminal "sair do estado" pela tela: o proximo drain tenta de novo.
// IMPORTANTE — assimetria intencional manual vs automatico: SO o reprocesso
// MANUAL (este botao) ressuscita 'inobtenivel'; o agendado/automatico nunca o
// faz sozinho (so drena 'pendente'), preservando o card como terminal.
// Idempotente (so toca quem esta no status alvo).
// ---------------------------------------------------------------------
async function reprocessarErros(
  service: ServiceClient,
  fonte: FonteDescobrivel | null,
  statusAlvo: "erro" | "inobtenivel" | "ignorado",
): Promise<number> {
  // Zera tentativas_extracao: o reprocesso manual e um RECOMECO, da um novo
  // ciclo de 3 tentativas ("faço manual, o sistema tenta 3x") em vez de cair
  // de cara no terminal porque ja estava no teto.
  let q = service
    .from("documento_vinculos")
    .update({ status_extracao: "pendente", erro: null, tentativas_extracao: 0 })
    .eq("status_extracao", statusAlvo);
  if (fonte) q = q.eq("fonte", fonte);
  const { data, error } = await q.select("id");
  if (error) {
    throw new HttpError(500, "reprocessar_falhou", "falha ao re-enfileirar anexos");
  }
  return Array.isArray(data) ? data.length : 0;
}

// ---------------------------------------------------------------------
// action='substituir-link': troca a URL do anexo de UM vinculo e o re-enfileira.
// Caso de uso: portais (ex.: Banrisul) REPUBLICAM o edital -> o link que a
// Effecti capturou (snapshot) morre (HTTP 5xx) e nem a Effecti nem a descoberta
// (ON CONFLICT DO NOTHING) trazem o link novo. Aqui o humano cola o link atual
// do portal; gravamos em ref_obtencao.url, voltamos a 'pendente' e zeramos o
// contador (novo ciclo de tentativas). So Effecti (unica fonte com URL publica
// colavel; Gmail usa attachment_id, Nomus base64). ESCRITA -> auditada.
// ---------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trava DETERMINISTICA anti-SSRF (SOM: regra critica no backend, nao na
 * confianca do operador). A URL aqui e DIGITADA livremente no cockpit e depois
 * o runner faz fetch() cega nela — diferente das URLs Effecti, que vem da API
 * da fonte (hosts de portal conhecidos). Bloqueia destinos internos: loopback,
 * link-local (inclui metadata 169.254.169.254), redes privadas, CGNAT e nomes
 * locais. So host PUBLICO de portal e aceito.
 */
function ehHostPrivado(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  // Literal IPv6 (URL.hostname ja remove os colchetes): loopback / link-local
  // (fe80::) / unique-local (fc00::/7 = fc.. ou fd..). Demais IPv6 = publico.
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
    return false;
  }
  // Nomes locais / internos (nunca sao portais publicos).
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  // Literal IPv4: faixas reservadas/privadas.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / privada
    if (a === 169 && b === 254) return true; // link-local (metadata cloud)
    if (a === 172 && b >= 16 && b <= 31) return true; // privada
    if (a === 192 && b === 168) return true; // privada (rede da empresa 192.168.1.x)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

function parseUrlSubstituta(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new HttpError(422, "url_ausente", "informe a nova URL do anexo");
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(422, "url_invalida", "a URL informada nao e valida");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new HttpError(422, "url_invalida", "a URL deve usar http ou https");
  }
  if (ehHostPrivado(u.hostname)) {
    throw new HttpError(
      422,
      "host_nao_permitido",
      "a URL deve apontar para um host publico (rede interna/loopback bloqueada)",
    );
  }
  return u.toString();
}

async function substituirLink(
  service: ServiceClient,
  idRaw: unknown,
  urlRaw: unknown,
): Promise<{ id: string; url: string; urlAnterior: string | null }> {
  const id = typeof idRaw === "string" ? idRaw.trim() : "";
  if (!UUID_RE.test(id)) {
    throw new HttpError(422, "id_invalido", "informe o id (uuid) do vinculo");
  }
  const url = parseUrlSubstituta(urlRaw);

  // Confere existencia + fonte ANTES de escrever (so Effecti tem URL colavel).
  const { data: row, error: selErr } = await service
    .from("documento_vinculos")
    .select("fonte, ref_obtencao")
    .eq("id", id)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "substituir_falhou", "falha ao ler o vinculo");
  }
  if (!row) {
    throw new HttpError(404, "vinculo_nao_encontrado", "vinculo de documento nao encontrado");
  }
  if (row.fonte !== "effecti") {
    throw new HttpError(
      422,
      "fonte_sem_link",
      "substituir link disponivel apenas para anexos da fonte Effecti",
    );
  }

  // Mescla com o ref existente (preserva nome/extensao); so a url muda. Volta a
  // 'pendente' e zera o contador -> novo ciclo de tentativas no proximo drain.
  const ref = row.ref_obtencao && typeof row.ref_obtencao === "object"
    ? (row.ref_obtencao as Record<string, unknown>)
    : {};
  // Guarda a url anterior (a quebrada) p/ a trilha de auditoria (de->para).
  const urlAnterior = typeof ref.url === "string" && ref.url ? ref.url : null;
  const { error: updErr } = await service
    .from("documento_vinculos")
    .update({
      ref_obtencao: { ...ref, url },
      status_extracao: "pendente",
      erro: null,
      tentativas_extracao: 0,
    })
    .eq("id", id);
  if (updErr) {
    throw new HttpError(500, "substituir_falhou", "falha ao gravar a nova URL do anexo");
  }
  return { id, url, urlAnterior };
}

// ---------------------------------------------------------------------
// action='ignorar-anexo': marca UM vinculo como 'ignorado' (status TERMINAL
// aplicado MANUALMENTE pelo humano). Caso de uso: ao avaliar um anexo em
// Erros/Inacessiveis, o humano decide que ele e dispensavel (ex.: arquivo
// morto na origem que nao vale recuperar) -> sai das listas e nao volta a ser
// processado. Inerte por construcao: o runner so consome 'pendente', a
// descoberta e ON CONFLICT DO NOTHING (nao ressuscita) e o reprocesso so toca
// o status alvo. Reversivel pelo card "Ignorados" (ignorado -> pendente).
// Vale para QUALQUER fonte. Preserva 'erro' (motivo) p/ contexto na lista.
// So ignora a partir de estados nao-bem-sucedidos (nunca extraido/herdado).
// ESCRITA -> auditada.
// ---------------------------------------------------------------------
async function ignorarAnexo(
  service: ServiceClient,
  idRaw: unknown,
): Promise<{ id: string; statusAnterior: string }> {
  const id = typeof idRaw === "string" ? idRaw.trim() : "";
  if (!UUID_RE.test(id)) {
    throw new HttpError(422, "id_invalido", "informe o id (uuid) do vinculo");
  }

  const { data: row, error: selErr } = await service
    .from("documento_vinculos")
    .select("status_extracao")
    .eq("id", id)
    .maybeSingle();
  if (selErr) {
    throw new HttpError(500, "ignorar_falhou", "falha ao ler o vinculo");
  }
  if (!row) {
    throw new HttpError(404, "vinculo_nao_encontrado", "vinculo de documento nao encontrado");
  }
  const statusAnterior = String(row.status_extracao);
  // Nao deixa ignorar um anexo ja extraido/herdado (sucesso): ignorar e uma
  // saida para anexos problematicos, nao para descartar conteudo bom.
  if (statusAnterior === "extraido" || statusAnterior === "herdado") {
    throw new HttpError(
      422,
      "status_nao_ignoravel",
      "apenas anexos pendentes ou com falha podem ser ignorados",
    );
  }

  const { error: updErr } = await service
    .from("documento_vinculos")
    .update({ status_extracao: "ignorado" })
    .eq("id", id);
  if (updErr) {
    throw new HttpError(500, "ignorar_falhou", "falha ao marcar o anexo como ignorado");
  }
  return { id, statusAnterior };
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

    // ESCRITA: re-enfileira os vinculos terminais (cockpit). Fonte opcional.
    // status alvo contextual ao card: 'inobtenivel' (inacessiveis) ou 'erro'
    // (default, transitorios). So o manual ressuscita 'inobtenivel'.
    if (body.action === "reprocessar-erros") {
      const fonteRaw = typeof body.fonte === "string" ? body.fonte : null;
      const fonte = fonteRaw && FONTES_DESCOBRIVEIS.includes(fonteRaw as FonteDescobrivel)
        ? (fonteRaw as FonteDescobrivel)
        : null;
      const statusAlvo = body.status === "inobtenivel"
        ? "inobtenivel"
        : body.status === "ignorado"
        ? "ignorado"
        : "erro";
      const reprocessados = await reprocessarErros(service, fonte, statusAlvo);
      await logSensitiveAction({
        tabela: "documento_vinculos",
        acao: "reprocessar_erros_extracao",
        usuario: caller.usuario,
        dadosNovos: { gatilho: caller.gatilho, fonte, status: statusAlvo, reprocessados },
      });
      return jsonResponse({ reprocessados, fonte, status: statusAlvo }, 200);
    }

    // ESCRITA: substitui a URL de UM anexo Effecti (link republicado pelo
    // portal) e o re-enfileira. Cola humana do link atual do portal.
    if (body.action === "substituir-link") {
      const { id, url, urlAnterior } = await substituirLink(service, body.id, body.url);
      await logSensitiveAction({
        tabela: "documento_vinculos",
        acao: "substituir_link_extracao",
        registroId: id,
        usuario: caller.usuario,
        dadosAnteriores: { url: urlAnterior },
        dadosNovos: { gatilho: caller.gatilho, url },
      });
      return jsonResponse({ ok: true, id }, 200);
    }

    // ESCRITA: marca UM anexo como 'ignorado' (terminal manual). O humano
    // avaliou e decidiu que o anexo e dispensavel. Sai das listas; reversivel
    // pelo card Ignorados. Qualquer fonte.
    if (body.action === "ignorar-anexo") {
      const { id, statusAnterior } = await ignorarAnexo(service, body.id);
      await logSensitiveAction({
        tabela: "documento_vinculos",
        acao: "ignorar_anexo_extracao",
        registroId: id,
        usuario: caller.usuario,
        dadosAnteriores: { status: statusAnterior },
        dadosNovos: { gatilho: caller.gatilho, status: "ignorado" },
      });
      return jsonResponse({ ok: true, id }, 200);
    }

    const input = parseInput(body);

    // Cada fonte tem sua funcao SQL de descoberta (mesma fila, adaptador
    // proprio no runner). Nomus varre nomus_processos; Effecti varre avisos;
    // Drive recebe a lista pronta do runner (a verdade vive na API do Google).
    let data: unknown;
    let error: unknown;
    let arquivosRecebidos: number | null = null;

    if (input.fonte === "gmail") {
      const itens = parseItensGmail(body);
      arquivosRecebidos = itens.length;
      ({ data, error } = await service.rpc("descobrir_vinculos_gmail", {
        p_itens: itens,
      }));
    } else if (input.fonte === "drive") {
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
