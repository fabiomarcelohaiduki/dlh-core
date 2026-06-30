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
const MAX_ARQUIVOS_DRIVE = 50_000;
const STATUS_VINCULO = ["pendente", "extraido", "herdado", "erro", "precisa_ocr", "inobtenivel", "ignorado"] as const;
type StatusVinculo = typeof STATUS_VINCULO[number];

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
  // Metadados do e-mail (headers MIME). assunto vira o titulo do registro;
  // remetente/destinatarios/cc/data_email alimentam o cabecalho da guia Dados.
  assunto: string | null;
  remetente: string | null;
  destinatarios: string | null;
  cc: string | null;
  data_email: string | null;
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
  // String trimada ou null (metadados opcionais do e-mail vindos do runner).
  const strOuNull = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
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
      assunto: strOuNull(r.assunto),
      remetente: strOuNull(r.remetente),
      destinatarios: strOuNull(r.destinatarios),
      cc: strOuNull(r.cc),
      data_email: strOuNull(r.data_email),
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Helpers de apresentacao do anexo (extensao + link de origem), usados ao
// montar a fila paginada.
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

// ---------------------------------------------------------------------
// action='fila-paginada': LEITURA paginada (keyset) da fila de extracao,
// para a guia "Fila de extracao". A pagina vem do Postgres via RPC
// extracao_fila_listar -> recall total, sem cap. As contagens (chips de
// fonte + cards de status + total) vem de extracao_fila_contagens(). O item
// carrega linkDoVinculo/extensaoDoNome/avisoUrl.
// ---------------------------------------------------------------------
const FILA_PAGE_DEFAULT = 50;
const FILA_PAGE_MAX = 200;

interface FilaCursor {
  u: string; // updated_at ISO (limite superior, exclusivo no keyset)
  k: string; // id (uuid) do ultimo item da pagina
}

interface FilaListParams {
  fonte: FonteDescobrivel | null;
  status: StatusVinculo | null;
  busca: string | null;
  cursor: FilaCursor | null;
  limit: number;
}

function parseFilaListParams(o: Record<string, unknown>): FilaListParams {
  const fonteRaw = typeof o.fonte === "string" ? o.fonte : null;
  const fonte = fonteRaw && FONTES_DESCOBRIVEIS.includes(fonteRaw as FonteDescobrivel)
    ? (fonteRaw as FonteDescobrivel)
    : null;

  const statusRaw = typeof o.status === "string" ? o.status : null;
  const status = statusRaw && STATUS_VINCULO.includes(statusRaw as StatusVinculo)
    ? (statusRaw as StatusVinculo)
    : null;

  const busca = typeof o.busca === "string" && o.busca.trim() !== ""
    ? o.busca.trim().slice(0, 200)
    : null;

  let cursor: FilaCursor | null = null;
  if (o.cursor && typeof o.cursor === "object") {
    const c = o.cursor as Record<string, unknown>;
    const u = typeof c.u === "string" ? c.u : "";
    const k = typeof c.k === "string" ? c.k : "";
    if (u && UUID_RE.test(k)) cursor = { u, k };
  }

  let limit = FILA_PAGE_DEFAULT;
  const lim = typeof o.limit === "number" ? o.limit : NaN;
  if (Number.isFinite(lim) && lim > 0) {
    limit = Math.min(Math.floor(lim), FILA_PAGE_MAX);
  }

  return { fonte, status, busca, cursor, limit };
}

/** Mapeia uma linha crua de documento_vinculos para o item da fila (mesmo
 * formato do resumo: link do anexo, extensao, link do aviso Effecti). */
function mapItemFila(r: Record<string, unknown>): Record<string, unknown> {
  const nome = typeof r.nome_anexo === "string" ? r.nome_anexo : null;
  const fonte = typeof r.fonte === "string" ? r.fonte : null;
  const processoId = r.registro_origem_id ?? null;
  return {
    id: String(r.id),
    status: typeof r.status_extracao === "string" ? r.status_extracao : null,
    fonte,
    processoId,
    nomeAnexo: nome,
    extensao: extensaoDoNome(nome),
    url: fonte ? linkDoVinculo(fonte, r.ref_obtencao) : null,
    avisoUrl: fonte === "effecti" && processoId != null
      ? `https://minha.effecti.com.br/#/aviso-edital-minhas/${processoId}`
      : null,
    erro: typeof r.erro === "string" ? r.erro : null,
    quando: r.updated_at ?? null,
  };
}

/** Dobra (fonte, status, qtd) em contagens por fonte (chips), por status
 * (cards), por fonte×status (cards quando ha fonte selecionada) e total. As 4
 * fontes vem sempre da RPC (linha NULL/0 quando vazia). */
function dobrarContagens(linhas: Array<Record<string, unknown>>): {
  porFonte: Record<string, number>;
  porStatus: Record<string, number>;
  porFonteStatus: Record<string, Record<string, number>>;
  total: number;
} {
  const porFonte: Record<string, number> = { effecti: 0, nomus: 0, gmail: 0, drive: 0 };
  const porStatus: Record<string, number> = {};
  const porFonteStatus: Record<string, Record<string, number>> = {};
  for (const s of STATUS_VINCULO) porStatus[s] = 0;
  let total = 0;
  for (const l of linhas) {
    const fonte = typeof l.fonte === "string" ? l.fonte : null;
    const status = typeof l.status === "string" ? l.status : null;
    const qtd = typeof l.qtd === "number" ? l.qtd : Number(l.qtd ?? 0);
    if (!status) continue; // linha de fonte-vazia (placeholder): nao soma
    if (fonte && fonte in porFonte) porFonte[fonte] += qtd;
    if (status in porStatus) porStatus[status] += qtd;
    if (fonte) (porFonteStatus[fonte] ??= {})[status] = (porFonteStatus[fonte]?.[status] ?? 0) + qtd;
    total += qtd;
  }
  return { porFonte, porStatus, porFonteStatus, total };
}

async function montarFilaPaginada(
  service: ServiceClient,
  params: FilaListParams,
): Promise<unknown> {
  // +1 para detectar se ha proxima pagina sem um COUNT separado.
  const { data: linhas, error: errList } = await service.rpc("extracao_fila_listar", {
    p_fonte: params.fonte,
    p_status: params.status,
    p_busca: params.busca,
    p_cursor_updated_at: params.cursor?.u ?? null,
    p_cursor_id: params.cursor?.k ?? null,
    p_limit: params.limit + 1,
  });
  if (errList) {
    throw new HttpError(500, "fila_listar_falhou", "falha ao listar a fila de extracao");
  }
  const todas = (linhas ?? []) as Array<Record<string, unknown>>;
  const temMais = todas.length > params.limit;
  const pagina = temMais ? todas.slice(0, params.limit) : todas;
  const itens = pagina.map(mapItemFila);

  let nextCursor: FilaCursor | null = null;
  if (temMais && pagina.length > 0) {
    const ultimo = pagina[pagina.length - 1];
    nextCursor = { u: String(ultimo.updated_at), k: String(ultimo.id) };
  }

  const { data: contLinhas, error: errCont } = await service.rpc("extracao_fila_contagens");
  if (errCont) {
    throw new HttpError(500, "fila_contagens_falhou", "falha ao contar a fila de extracao");
  }
  const contagens = dobrarContagens((contLinhas ?? []) as Array<Record<string, unknown>>);

  return { itens, nextCursor, contagens };
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
// So ignora a partir de 'erro' ou 'inobtenivel' (allowlist); o UPDATE e
// condicionado a esses status (fecha TOCTOU, 0 linhas -> 409).
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
  // Allowlist: ignorar e uma saida SO para anexos que falharam (erro ou
  // inobtenivel). Nunca para sucesso (extraido/herdado) nem para 'pendente'
  // (ainda em processamento) ou 'precisa_ocr' (na fila do OCR).
  if (statusAnterior !== "erro" && statusAnterior !== "inobtenivel") {
    throw new HttpError(
      422,
      "status_nao_ignoravel",
      "apenas anexos com falha (erro ou inacessivel) podem ser ignorados",
    );
  }

  // UPDATE condicionado ao status alvo: fecha a janela TOCTOU (o status pode
  // mudar entre o SELECT e o UPDATE, ex.: um run concorrente reextrai o anexo).
  // 0 linhas afetadas = o status saiu da allowlist no meio -> 409.
  const { data: atualizadas, error: updErr } = await service
    .from("documento_vinculos")
    .update({ status_extracao: "ignorado" })
    .eq("id", id)
    .in("status_extracao", ["erro", "inobtenivel"])
    .select("id");
  if (updErr) {
    throw new HttpError(500, "ignorar_falhou", "falha ao marcar o anexo como ignorado");
  }
  if (!atualizadas || atualizadas.length === 0) {
    throw new HttpError(
      409,
      "status_mudou",
      "o anexo deixou de estar em falha antes de ser ignorado; recarregue e tente de novo",
    );
  }
  return { id, statusAnterior };
}

// ---------------------------------------------------------------------
// action='ignorar-em-massa': marca TODOS os vinculos de um status de falha
// (status alvo -> 'ignorado') de uma vez, CONTEXTUAL ao card selecionado:
// card Erros ignora 'erro', card Inacessíveis ignora 'inobtenivel'. Fonte
// opcional (ausente = todas). Versao em volume do 'ignorar-anexo': o humano
// avaliou a lista e decidiu que todos sao dispensaveis (ex.: lote de arquivos
// mortos na origem que nao vale recuperar). Sai das listas e nao volta a ser
// processado. Allowlist no UPDATE (so 'erro'/'inobtenivel') -> nunca ignora
// sucesso/pendente/OCR. Reversivel em massa pelo card "Ignorados". Preserva
// 'erro' (motivo) p/ contexto. ESCRITA -> auditada.
// ---------------------------------------------------------------------
async function ignorarEmMassa(
  service: ServiceClient,
  fonte: FonteDescobrivel | null,
  statusAlvo: "erro" | "inobtenivel",
): Promise<number> {
  let q = service
    .from("documento_vinculos")
    .update({ status_extracao: "ignorado" })
    .eq("status_extracao", statusAlvo)
    // Trava defensiva (cinto-e-suspensorio, igual ao ignorar-anexo 1-a-1): a
    // funcao nao confia SO na sanitizacao do handler. Ignorar e saida apenas
    // para anexos com falha; nunca toca sucesso (extraido/herdado), pendente
    // nem precisa_ocr, mesmo que um caller futuro passe outro statusAlvo.
    .in("status_extracao", ["erro", "inobtenivel"]);
  if (fonte) q = q.eq("fonte", fonte);
  const { data, error } = await q.select("id");
  if (error) {
    throw new HttpError(500, "ignorar_em_massa_falhou", "falha ao ignorar os anexos em massa");
  }
  return Array.isArray(data) ? data.length : 0;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "POST");
    const caller = await resolveCaller(req);
    const body = await readBody(req);
    const service = createServiceClient();

    // LEITURA paginada (keyset) da fila de extracao p/ a guia "Fila de
    // extracao": pagina + contagens (chips/cards/total). Nao audita.
    if (body.action === "fila-paginada") {
      return jsonResponse(await montarFilaPaginada(service, parseFilaListParams(body)), 200);
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

    // ESCRITA: marca TODOS os anexos de um status de falha como 'ignorado' de
    // uma vez (versao em massa do ignorar-anexo). status alvo contextual ao
    // card: 'inobtenivel' (inacessiveis) ou 'erro'. Fonte opcional. Reversivel
    // em massa pelo card Ignorados.
    if (body.action === "ignorar-em-massa") {
      const fonteRaw = typeof body.fonte === "string" ? body.fonte : null;
      const fonte = fonteRaw && FONTES_DESCOBRIVEIS.includes(fonteRaw as FonteDescobrivel)
        ? (fonteRaw as FonteDescobrivel)
        : null;
      const statusAlvo = body.status === "inobtenivel" ? "inobtenivel" : "erro";
      const ignorados = await ignorarEmMassa(service, fonte, statusAlvo);
      await logSensitiveAction({
        tabela: "documento_vinculos",
        acao: "ignorar_em_massa_extracao",
        usuario: caller.usuario,
        dadosNovos: { gatilho: caller.gatilho, fonte, status: statusAlvo, ignorados },
      });
      return jsonResponse({ ignorados, fonte, status: statusAlvo }, 200);
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
