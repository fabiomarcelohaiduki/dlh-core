// Coletor Nomus de NUVEM (GitHub Actions runner, Node/OpenSSL).
//
// MOTIVO: o Supabase Edge (Deno/rustls) nao conecta no Nomus por
// incompatibilidade TLS (Nomus so oferece cifra CBC legada). Este runner roda
// em Node (OpenSSL), que conecta normalmente. Ele:
//   1) pagina GET /rest/processos?pagina=N (1-indexed) ate vir pagina vazia;
//   2) respeita o throttling do Nomus (429 Retry-After e corpo
//      {tempoAteLiberar}, que pode vir ate com status 200);
//   3) estripa o anexoBase64 de cada processo (mantem metadata do anexo) logo
//      apos o fetch — evita OOM de heap no backfill e payloads gigantes;
//   4) faz push dos processos (em lotes) para a Edge Function nomus-ingerir,
//      que reaproveita o pipeline de persistencia/indexacao do cockpit.
//
// Nao grava nada localmente. Toda a logica de dedup/reindex/execucao vive no
// Edge (nomus-ingerir), preservando o cockpit integrado.
//
// Env obrigatorias:
//   NOMUS_API_KEY          chave Basic do Nomus
//   SUPABASE_URL           ex.: https://<ref>.supabase.co
//   CRON_DISPATCH_SECRET   segredo de sistema (X-Cron-Secret) do nomus-ingerir
// Env opcionais:
//   NOMUS_BASE_URL         default https://famaha.nomus.com.br/famaha
//   SUPABASE_ANON_KEY      apikey do gateway (incluida quando presente)
//   NOMUS_RECURSO          default "processos"
//   NOMUS_MODO             "incremental" (default) | "full"
//   NOMUS_TAMANHO_LOTE     paginas por lote antes da pausa (default 14)
//   NOMUS_PAUSA_LOTE_MS    pausa entre lotes em ms (default 5000)
//   NOMUS_MAX_RETRIES      tentativas por pagina (default 5)
//   NOMUS_MAX_PAGINAS      teto de seguranca de paginas (default 1000)
//   NOMUS_GET_TIMEOUT_MS   timeout por GET de pagina (default 600000 = 10min)
//   NOMUS_NETWORK_RETRY_FLOOR_MS  piso de espera pos fetch failed (default 15000)
//
// MODO de coleta:
//   incremental (default) — pede ao Edge a MARCA D'AGUA (maior nomus_id ja
//     persistido) e so puxa processos NOVOS (id > marca). A listagem do Nomus
//     vem por id DESC, entao o runner para assim que alcanca a marca, sem
//     varrer todas as paginas. E o regime permanente (cron horario).
//   full — backfill: ignora a marca e varre TODAS as paginas (1x, p/ trazer o
//     historico antigo abaixo do max). Acionado manualmente (workflow_dispatch).

const KEY = process.env.NOMUS_API_KEY;
const BASE = (process.env.NOMUS_BASE_URL?.trim() || "https://famaha.nomus.com.br/famaha").replace(
  /\/+$/,
  "",
);
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const CRON_SECRET = process.env.CRON_DISPATCH_SECRET;
const ANON = process.env.SUPABASE_ANON_KEY;
const RECURSO = process.env.NOMUS_RECURSO ?? "processos";
const MODO = (process.env.NOMUS_MODO?.trim().toLowerCase() === "full") ? "full" : "incremental";
// Gatilho da coleta: o disparo manual (card da fonte) manda 'manual'; o agendado
// (pg_cron) nao passa -> default 'agendada'. Vai no push body p/ a Edge gravar em
// execucoes.gatilho (a tela de execucoes distingue manual de agendada).
const GATILHO = (process.env.NOMUS_GATILHO ?? "agendada").trim() === "manual" ? "manual" : "agendada";
// A JANELA de coleta (data de corte) vive no cockpit (config_ingestao.
// data_inicial) e e aplicada pela Edge Function nomus-ingerir. Este runner so
// puxa e empurra; nao filtra por data.

const TAMANHO_LOTE = posInt(process.env.NOMUS_TAMANHO_LOTE, 14);
const PAUSA_LOTE_MS = posInt(process.env.NOMUS_PAUSA_LOTE_MS, 5_000);
const MAX_RETRIES = posInt(process.env.NOMUS_MAX_RETRIES, 5);
const MAX_PAGINAS = posInt(process.env.NOMUS_MAX_PAGINAS, 1_000);
// Tamanho do lote de PUSH ao Edge. O Edge tem orcamento de CPU/memoria por
// invocacao, entao enviamos poucos registros por vez (default 25).
const PUSH_CHUNK = posInt(process.env.NOMUS_PUSH_CHUNK, 25);
const BASE_DELAY_MS = 500;
const BACKOFF_TETO_MS = 60_000;
// Acima deste tempo, o GET de UMA pagina e considerado "lento" e logado. O
// Nomus faz throttle por LATENCIA (tarpit), nao por 429: a propria resposta
// demora (medido 2,5s a 140s/pagina, sem nenhum 429/tempoAteLiberar). Este log
// da visibilidade ao throttle silencioso, que o log [rate-limit] nao captura.
const SLOW_GET_MS = posInt(process.env.NOMUS_SLOW_GET_MS, 30_000);
// Timeout EXPLICITO por GET de pagina. O tarpit do Nomus ja empurrou um unico
// GET para 311s (run #32); o default do undici (~300s headersTimeout) estoura
// nesses casos e o `fetch` rejeita com "fetch failed", derrubando o run. Damos
// folga ampla (10min) para o tarpit responder sem matar o job; o AbortSignal
// garante que um GET pendurado nao trave o runner para sempre.
const GET_TIMEOUT_MS = posInt(process.env.NOMUS_GET_TIMEOUT_MS, 600_000);
// Piso de espera entre tentativas APOS falha de rede (fetch failed). O backoff
// exponencial padrao comeca em 0,5s — curto demais para o tarpit aliviar. Com
// piso de 15s, as MAX_RETRIES tentativas somam fôlego suficiente (~75s+) para o
// gateway do Nomus respirar antes de desistir e abortar o run.
const NETWORK_RETRY_FLOOR_MS = posInt(process.env.NOMUS_NETWORK_RETRY_FLOOR_MS, 15_000);

function posInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function fail(msg, code = 2) {
  console.error(`ERRO: ${msg}`);
  process.exit(code);
}

if (!KEY) fail("env NOMUS_API_KEY ausente.");
if (!SUPABASE_URL) fail("env SUPABASE_URL ausente.");
if (!CRON_SECRET) fail("env CRON_DISPATCH_SECRET ausente.");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt) {
  const exp = BASE_DELAY_MS * 2 ** attempt;
  const capped = Math.min(exp, BACKOFF_TETO_MS);
  return Math.floor(capped + Math.random() * (capped * 0.2));
}

/**
 * Remove o `anexoBase64` de cada item de `arquivosAnexos`, preservando a
 * metadata (`nome`, `extensao`). A API do Nomus inlina o PDF inteiro em base64
 * (117k-521k chars/anexo, ~2,6 MB por processo de Venda Governamental). Sem
 * este strip, o backfill acumularia GBs no heap do runner (OOM aos ~56 min) e
 * mandaria payloads gigantes ao Edge. Aplicado AQUI (logo apos o fetch), antes
 * de acumular/enviar. O Edge faz o mesmo strip de forma idempotente (espelha o
 * Effecti, cuja API ja entrega anexos como metadata). Carve-out ao SEC-08:
 * payload fiel EXCETO pelo blob de anexo, removido por peso.
 */
function stripAnexosBase64(proc) {
  if (!proc || typeof proc !== "object") return proc;
  const anexos = proc.arquivosAnexos;
  if (!Array.isArray(anexos)) return proc;
  return {
    ...proc,
    arquivosAnexos: anexos.map((a) => {
      if (!a || typeof a !== "object") return a;
      const { anexoBase64: _omit, ...meta } = a;
      return meta;
    }),
  };
}

/** Le {tempoAteLiberar:<seg>} do corpo (rate limit do Nomus). null se ausente. */
function peekTempoAteLiberar(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const t = j.tempoAteLiberar;
      if (typeof t === "number" && Number.isFinite(t) && t > 0) return t * 1000;
    }
  } catch (_) {
    // corpo nao-JSON: ignora.
  }
  return null;
}

/** Busca UMA pagina com retry/backoff. Retorna o array de processos da pagina. */
async function fetchPagina(pagina) {
  // O endpoint deriva do recurso (NOMUS_RECURSO). Com o default "processos" a
  // URL e identica a de sempre (/rest/processos). Costura para o 2o modulo:
  // ATENCAO, antes de ligar um novo recurso confirme o path real do Nomus
  // (assumimos a convencao REST /rest/<recurso>) E adicione o mapper proprio
  // no Edge (mapRawProcesso so conhece processos).
  const url = `${BASE}/rest/${encodeURIComponent(RECURSO)}?pagina=${pagina}`;
  let attempt = 0;

  while (true) {
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(GET_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        fail(`falha de rede ao contatar o Nomus (pagina ${pagina}): ${err?.message ?? err}`, 1);
      }
      // Falha de rede (fetch failed / timeout) costuma ser o tarpit do Nomus
      // engasgado: espera com PISO maior que o backoff exponencial padrao para
      // dar tempo do gateway aliviar antes da proxima tentativa.
      const waitMs = Math.max(backoff(attempt), NETWORK_RETRY_FLOOR_MS);
      console.error(
        `[rede] pagina ${pagina}: ${err?.message ?? err} ` +
          `(tentativa ${attempt + 1}/${MAX_RETRIES}), aguardando ${Math.round(waitMs / 1000)}s`,
      );
      await delay(waitMs);
      attempt += 1;
      continue;
    }

    if (res.status === 401) fail("credencial Nomus invalida (401).", 1);

    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) fail("limite de requisicoes atingido (429).", 1);
      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : backoff(attempt);
      console.error(
        `[rate-limit] pagina ${pagina}: HTTP 429 (tentativa ${attempt + 1}/${MAX_RETRIES}), ` +
          `aguardando ${Math.round(waitMs / 1000)}s`,
      );
      await delay(waitMs);
      attempt += 1;
      continue;
    }

    if (res.status >= 500) {
      if (attempt >= MAX_RETRIES) fail(`erro do servico Nomus (${res.status}).`, 1);
      await delay(backoff(attempt));
      attempt += 1;
      continue;
    }

    // Lemos o corpo ANTES de decidir falhar: o rate limit do Nomus
    // ({tempoAteLiberar}) pode vir junto de um status 200 OU ate de um 400.
    // Se ja falhassemos no !res.ok, perderiamos esse sinal de espera.
    const text = await res.text();

    // Rate limit pode vir no CORPO ({tempoAteLiberar}), independente do status.
    const tempoMs = peekTempoAteLiberar(text);
    if (tempoMs !== null) {
      if (attempt >= MAX_RETRIES) fail("limite de requisicoes atingido (tempoAteLiberar).", 1);
      console.error(
        `[rate-limit] pagina ${pagina}: Nomus pediu espera ` +
          `(tempoAteLiberar=${Math.round(tempoMs / 1000)}s, tentativa ${attempt + 1}/${MAX_RETRIES})`,
      );
      await delay(tempoMs + 1_000);
      attempt += 1;
      continue;
    }

    // HTTP 400 sem tempoAteLiberar, tipicamente apos GETs lentos (tarpit): e
    // throttle/transiente do gateway do Nomus, NAO request malformado (as
    // paginas anteriores usaram request identico e funcionaram). Tratamos como
    // recuperavel com backoff em vez de matar o job e perder todo o progresso.
    if (res.status === 400) {
      if (attempt >= MAX_RETRIES) {
        fail(`requisicao Nomus rejeitada (400) apos ${MAX_RETRIES} tentativas.`, 1);
      }
      console.error(
        `[rate-limit] pagina ${pagina}: HTTP 400 (provavel throttle do gateway, ` +
          `tentativa ${attempt + 1}/${MAX_RETRIES}), aguardando backoff`,
      );
      await delay(backoff(attempt));
      attempt += 1;
      continue;
    }

    if (!res.ok) fail(`requisicao Nomus rejeitada (${res.status}).`, 1);

    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      fail(`resposta nao-JSON na pagina ${pagina}.`, 1);
    }
    // Estripa o anexoBase64 JA NA SAIDA do fetch: tudo que e acumulado/enviado
    // adiante carrega apenas a metadata do anexo (evita OOM no backfill).
    return Array.isArray(json) ? json.map(stripAnexosBase64) : [];
  }
}

/**
 * Backfill FULL com PUSH POR PAGINA: cada pagina coletada e empurrada na hora
 * ao Edge, sob UMA execucao compartilhada (criada no 1o push). Salva o progresso
 * continuamente — se o run for morto (timeout 6h), o ja gravado permanece — e
 * mantem a memoria minima. A pagina vazia encerra a varredura e finaliza a
 * execucao com final:true. Sem cursor de retomada ainda: o log de rate limit
 * deste run mede o throttle e decide se 1 run basta ou se sera preciso fatiar.
 */
async function coletarEEnviarFull(desdePagina = 1, dataCorte = null) {
  const t0 = Date.now();
  let execucaoId = null;
  const acc = { novos: 0, alterados: 0, ignorados: 0, erros: 0, recebidos: 0 };
  let totalColetado = 0;
  let chamadasNoLote = 0;

  if (desdePagina > 1) {
    console.error(`Retomada: iniciando da pagina ${desdePagina} (paginas anteriores ja varridas).`);
  }

  for (let pagina = desdePagina; pagina <= MAX_PAGINAS; pagina++) {
    const tGet0 = Date.now();
    const lista = await fetchPagina(pagina);
    const getMs = Date.now() - tGet0;
    if (getMs >= SLOW_GET_MS) {
      console.error(
        `[slow-get] pagina ${pagina}: GET levou ${(getMs / 1000).toFixed(1)}s ` +
          `(throttle por latencia do Nomus, sem 429)`,
      );
    }
    const isFim = lista.length === 0; // pagina vazia encerra a varredura.
    // Corte por IDADE (janela deslizante): a listagem vem id DESC = data DESC
    // (0 inversoes confirmadas). Se a pagina ja contem um processo mais antigo
    // que o corte, dali p/ baixo e tudo mais antigo => esta e a ULTIMA pagina:
    // envia (o Edge filtra os < corte) com final:true e encerra. Espelha o
    // "alcancou a marca" do incremental, mas por data em vez de watermark.
    const cruzouCorte = !isFim && dataCorte !== null &&
      lista.some((p) => {
        const dt = dataCriacaoIso(p);
        return dt !== null && dt < dataCorte;
      });
    const ultima = isFim || cruzouCorte;

    const body = {
      gatilho: GATILHO,
      recurso: RECURSO,
      pagina,
      processos: lista,
      ...(execucaoId ? { execucao_id: execucaoId } : {}),
      // No lote final manda o tempo total do runner (desde o startedAt) p/ a Edge
      // gravar duracao real: a execucao nasce no 1o push (lazy), entao fim-inicio
      // do banco subconta o tempo de leitura do Nomus.
      ...(ultima ? { final: true, duracao_ms: Date.now() - startedAt } : {}),
    };

    const tPost0 = Date.now();
    const r = await postLote(body);
    const postMs = Date.now() - tPost0;

    if (r.status === 409 && !execucaoId) {
      fail(`coleta recusada: ja ha execucao em andamento (${r.text.slice(0, 200)})`, 1);
    }
    if (!r.ok) {
      if (execucaoId) await abortarExecucao(execucaoId);
      fail(`push da pagina ${pagina} falhou (${r.status}): ${r.text.slice(0, 300)}`, 1);
    }

    if (!execucaoId) execucaoId = r.json?.execucao_id ?? null;
    acc.novos += r.json?.novos ?? 0;
    acc.alterados += r.json?.alterados ?? 0;
    acc.ignorados += r.json?.ignorados ?? 0;
    acc.erros += r.json?.erros ?? 0;
    acc.recebidos += r.json?.recebidos ?? lista.length;

    if (isFim) {
      console.error(`[pagina ${pagina}] vazia: fim da varredura, execucao finalizada.`);
      break;
    }

    totalColetado += lista.length;
    console.error(
      `[pagina ${pagina}] +${lista.length} enviado | acum novos=${acc.novos} ` +
        `alterados=${acc.alterados} ignorados=${acc.ignorados} erros=${acc.erros} ` +
        `(coletado ${totalColetado}) | get=${(getMs / 1000).toFixed(1)}s ` +
        `post=${(postMs / 1000).toFixed(1)}s t=${Math.round((Date.now() - t0) / 1000)}s`,
    );

    if (cruzouCorte) {
      console.error(
        `[pagina ${pagina}] cruzou o corte de idade (${dataCorte}): ultima pagina da ` +
          `janela deslizante, execucao finalizada.`,
      );
      break;
    }

    chamadasNoLote += 1;
    if (chamadasNoLote >= TAMANHO_LOTE) {
      chamadasNoLote = 0;
      await delay(PAUSA_LOTE_MS);
    }
  }

  return { execucaoId, ...acc, totalColetado };
}

/** id numerico do processo (p.id). NaN quando ausente/nao-numerico. */
function idNum(p) {
  const n = Number(p?.id);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Data de criacao do processo bruto como 'YYYY-MM-DD'. A listagem do Nomus traz
 * `dataCriacao` em DD/MM/YYYY (sem hora); tambem aceita ISO por robustez. null
 * quando ausente/ilegivel (nesse caso o processo NUNCA dispara o corte de idade).
 */
function dataCriacaoIso(p) {
  const s = p?.dataCriacao ?? p?.data_criacao;
  if (typeof s !== "string") return null;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

/**
 * Coleta INCREMENTAL: a listagem vem por id DESC (novos primeiro). Puxa apenas
 * processos com id > marca d'agua e PARA assim que a pagina alcanca um id ja
 * conhecido (<= marca) — evita varrer todas as paginas. Ids nao-numericos sao
 * mantidos por seguranca (nunca descartados; dedup no Edge resolve).
 */
async function coletarIncremental(watermark) {
  const processos = [];
  let chamadasNoLote = 0;

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const lista = await fetchPagina(pagina);
    if (lista.length === 0) break; // pagina vazia encerra a varredura.

    let alcancouConhecido = false;
    for (const p of lista) {
      const n = idNum(p);
      if (Number.isNaN(n) || n > watermark) {
        processos.push(p);
      } else {
        alcancouConhecido = true; // id <= marca: dali p/ baixo ja esta no banco.
      }
    }
    console.error(
      `[pagina ${pagina}] novos+${processos.length} (lote ${lista.length})` +
        (alcancouConhecido ? " | alcancou a marca, encerrando" : ""),
    );
    if (alcancouConhecido) break;

    chamadasNoLote += 1;
    if (chamadasNoLote >= TAMANHO_LOTE) {
      chamadasNoLote = 0;
      await delay(PAUSA_LOTE_MS);
    }
  }
  return processos;
}

const INGERIR_URL = `${SUPABASE_URL}/functions/v1/nomus-ingerir`;

function ingerirHeaders() {
  const headers = {
    "Content-Type": "application/json",
    "X-Cron-Secret": CRON_SECRET,
  };
  if (ANON) {
    headers["apikey"] = ANON;
    headers["Authorization"] = `Bearer ${ANON}`;
  }
  return headers;
}

/** POST de um lote para o nomus-ingerir. Retorna { status, json|text }. */
async function postLote(body) {
  const res = await fetch(INGERIR_URL, {
    method: "POST",
    headers: ingerirHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    // mantem text cru.
  }
  return { status: res.status, ok: res.ok, json, text };
}

/**
 * Le a MARCA D'AGUA no Edge (action: "watermark"): maior nomus_id ja
 * persistido. Retorna number ou null (banco vazio => coleta full).
 */
async function fetchWatermark() {
  const r = await postLote({ action: "watermark", recurso: RECURSO });
  if (!r.ok) fail(`falha ao obter a marca d'agua (${r.status}): ${r.text.slice(0, 300)}`, 1);
  const raw = r.json?.max_nomus_id;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Le a DATA DE CORTE da janela deslizante no Edge (action: "janela"): hoje -
 * janela_dias, ja resolvida pela config (cockpit). O full PARA a varredura ao
 * cruzar este corte. null = sem janela configurada (varre tudo).
 */
async function fetchDataCorte() {
  const r = await postLote({ action: "janela", recurso: RECURSO });
  if (!r.ok) {
    console.error(`[janela] falha ao obter o corte (${r.status}); varrendo sem corte de idade.`);
    return null;
  }
  const dc = r.json?.data_corte;
  return typeof dc === "string" && dc.length >= 10 ? dc.slice(0, 10) : null;
}

/**
 * Pergunta ao Edge de qual pagina iniciar o backfill (cursor de retomada).
 * O Edge devolve { desde_pagina } e, se houver execucao ORFA (run anterior
 * morto por timeout 6h / cancel), a aborta sozinho e manda continuar da
 * proxima pagina. Se ja houver um run ATIVO (lote recente), responde 409 e
 * abortamos este ciclo para nao colidir.
 */
async function fetchRetomar() {
  const r = await postLote({ action: "retomar", recurso: RECURSO });
  if (r.status === 409 && r.json?.ja_ativo) {
    fail(`coleta recusada: ja ha um run ATIVO em andamento (execucao ${r.json?.execucao_id}).`, 1);
  }
  if (!r.ok) fail(`falha ao consultar retomada (${r.status}): ${r.text.slice(0, 300)}`, 1);
  const desde = Number(r.json?.desde_pagina);
  return Number.isFinite(desde) && desde >= 1 ? Math.floor(desde) : 1;
}

/** Pede ao Edge para marcar a execucao em 'erro' (libera o single-flight). */
async function abortarExecucao(execucaoId) {
  try {
    await postLote({ recurso: RECURSO, execucao_id: execucaoId, abort: true });
    console.error(`Execucao ${execucaoId} marcada como erro (abort).`);
  } catch (e) {
    console.error(`Falha ao abortar execucao ${execucaoId}: ${e?.message ?? e}`);
  }
}

/** Envia todos os processos em lotes de PUSH_CHUNK, sob 1 unica execucao. */
async function pushEmLotes(processos) {
  if (processos.length === 0) {
    // Sem registros: ainda cria+finaliza uma execucao 'concluida' (recebidos 0).
    const r = await postLote({
      gatilho: GATILHO,
      recurso: RECURSO,
      processos: [],
      final: true,
      duracao_ms: Date.now() - startedAt,
    });
    if (!r.ok) fail(`push (vazio) falhou (${r.status}): ${r.text.slice(0, 500)}`, 1);
    return r;
  }

  let execucaoId = null;
  let acc = { novos: 0, alterados: 0, ignorados: 0, erros: 0, recebidos: 0 };

  for (let i = 0; i < processos.length; i += PUSH_CHUNK) {
    const lote = processos.slice(i, i + PUSH_CHUNK);
    const isFinal = i + PUSH_CHUNK >= processos.length;
    const body = {
      gatilho: GATILHO,
      recurso: RECURSO,
      processos: lote,
      ...(execucaoId ? { execucao_id: execucaoId } : {}),
      ...(isFinal ? { final: true, duracao_ms: Date.now() - startedAt } : {}),
    };

    const r = await postLote(body);

    if (r.status === 409 && !execucaoId) {
      // Ja ha execucao em andamento no sistema: aborta este ciclo (sem criar).
      fail(`coleta recusada: ja ha execucao em andamento (${r.text.slice(0, 200)})`, 1);
    }
    if (!r.ok) {
      if (execucaoId) await abortarExecucao(execucaoId);
      fail(`push do lote ${i / PUSH_CHUNK + 1} falhou (${r.status}): ${r.text.slice(0, 300)}`, 1);
    }

    if (!execucaoId) execucaoId = r.json?.execucao_id ?? null;
    acc.novos += r.json?.novos ?? 0;
    acc.alterados += r.json?.alterados ?? 0;
    acc.ignorados += r.json?.ignorados ?? 0;
    acc.erros += r.json?.erros ?? 0;
    acc.recebidos += r.json?.recebidos ?? lote.length;
    console.error(
      `[lote ${i / PUSH_CHUNK + 1}] enviados ${lote.length} | acumulado novos=${acc.novos} ` +
        `alterados=${acc.alterados} ignorados=${acc.ignorados} erros=${acc.erros}`,
    );
  }

  return { execucaoId, ...acc };
}

const startedAt = Date.now();

let resumo;
if (MODO === "full") {
  const desde = await fetchRetomar();
  const dataCorte = await fetchDataCorte();
  console.log(
    `Modo FULL (backfill): push por pagina, cursor de retomada (desde pagina ${desde})` +
      (dataCorte
        ? `, corte de idade em ${dataCorte} (para ao cruzar).`
        : ", sem corte de idade (varre tudo).") +
      ` Logs ativos: [rate-limit] (429) e [slow-get] (latencia > ${SLOW_GET_MS / 1000}s).`,
  );
  resumo = await coletarEEnviarFull(desde, dataCorte);
} else {
  const watermark = await fetchWatermark();
  if (watermark === null) {
    const desde = await fetchRetomar();
    console.log(`Modo incremental, banco vazio: varredura completa por pagina (desde ${desde}).`);
    resumo = await coletarEEnviarFull(desde);
  } else {
    console.log(`Modo incremental: coletando processos com id > ${watermark}.`);
    const processos = await coletarIncremental(watermark);
    console.log(`Coletados ${processos.length} novos em ${Date.now() - startedAt}ms.`);
    resumo = await pushEmLotes(processos);
  }
}
console.log(`Concluido em ${Date.now() - startedAt}ms.`);
console.log("Resumo da ingestao:");
console.log(JSON.stringify(resumo, null, 2));
process.exit(0);
