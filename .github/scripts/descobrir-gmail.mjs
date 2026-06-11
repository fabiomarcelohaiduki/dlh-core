// =====================================================================
// .github/scripts/descobrir-gmail.mjs
// DESCOBERTA da fonte 'gmail' (camada 1). Roda ANTES do extrair-anexos.mjs:
// monta a query Gmail (data inicial + labels a EXCLUIR, administradas no
// cockpit), lista as mensagens, e para CADA mensagem enfileira no Edge
// documentos-descobrir um item 'corpo' + N itens 'anexo' (coleta por
// mensagem, decisao Fabio 2026-06-09). O thread_id viaja em cada item.
//
// O extrair-anexos.mjs depois consome a MESMA fila (sem filtro de fonte),
// obtem os bytes pelo adaptador 'gmail' (corpo = re-extrai a mensagem;
// anexo = baixa os bytes) e extrai via extrator/Tika.
//
// POR QUE NO RUNNER (e nao SQL como Nomus/Effecti): a lista de mensagens vive
// na API do Google, nao no banco. A credencial Gmail so existe aqui. O Edge
// so persiste (service_role) — espelha a divisao do Drive.
//
// QUERY (na ordem de precedencia):
//   1. GMAIL_QUERY (override do workflow) — query Gmail crua; use para teste
//      pontual de 1 email, ignorando o cadastro do cockpit.
//   2. Edge gmail-config (action='montar-query') — monta a partir de
//      gmail_config.data_inicial + gmail_labels ativas (blacklist).
//
// Env obrigatorias:
//   SUPABASE_URL                 https://<ref>.supabase.co
//   CRON_DISPATCH_SECRET         X-Cron-Secret do Edge (gmail.mjs troca por um
//                                access_token fresco na Edge gmail-oauth)
// Env opcionais:
//   SUPABASE_ANON_KEY            apikey do gateway (incluida quando presente)
//   GMAIL_QUERY                  override: query crua (teste pontual)
//   GMAIL_MAX                    teto de mensagens varridas (default: sem teto)
//   GMAIL_DESCOBRIR_LOTE         itens por POST ao Edge (default 500)
// =====================================================================

import {
  extrairConteudo,
  listarMensagens,
  obterMensagem,
  NOME_CORPO,
} from "./gmail.mjs";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const CRON_SECRET = process.env.CRON_DISPATCH_SECRET;
const ANON = process.env.SUPABASE_ANON_KEY;
const QUERY_OVERRIDE = (process.env.GMAIL_QUERY ?? "").trim();
const MAX = Number(process.env.GMAIL_MAX) > 0 ? Math.floor(Number(process.env.GMAIL_MAX)) : Infinity;
const LOTE = Number(process.env.GMAIL_DESCOBRIR_LOTE) || 500;

function fail(msg, code = 2) {
  console.error(`ERRO: ${msg}`);
  process.exit(code);
}

if (!SUPABASE_URL) fail("env SUPABASE_URL ausente.");
if (!CRON_SECRET) fail("env CRON_DISPATCH_SECRET ausente.");

const DESCOBRIR_URL = `${SUPABASE_URL}/functions/v1/documentos-descobrir`;
const CONFIG_URL = `${SUPABASE_URL}/functions/v1/gmail-config`;
const EXECUCAO_URL = `${SUPABASE_URL}/functions/v1/gmail-execucao`;
// 'manual' (disparo pelo card) ou 'agendada' (cron->GitHub API). Default agendada.
const GATILHO = (process.env.GMAIL_GATILHO ?? "agendada").trim() === "manual" ? "manual" : "agendada";

function headers() {
  const h = { "Content-Type": "application/json", "X-Cron-Secret": CRON_SECRET };
  if (ANON) {
    h["apikey"] = ANON;
    h["Authorization"] = `Bearer ${ANON}`;
  }
  return h;
}

/**
 * Resolve a(s) query(s): override do workflow OU as montadas pelo Edge (cockpit).
 * A janela incremental de dois lados pode devolver 1-2 queries (NOVOS + ANTIGOS);
 * devolve sempre um array (override = 1 query crua).
 */
async function resolverQueries() {
  if (QUERY_OVERRIDE) {
    console.log(`Override GMAIL_QUERY: usando query crua "${QUERY_OVERRIDE}".`);
    return [QUERY_OVERRIDE];
  }
  const res = await fetch(CONFIG_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ action: "montar-query" }),
  });
  const text = await res.text();
  if (!res.ok) {
    fail(
      `gmail-config (montar-query) falhou (${res.status}): ${text.slice(0, 300)}. ` +
        `Defina GMAIL_QUERY para teste pontual ou configure o card Gmail no cockpit.`,
      1,
    );
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    fail("resposta nao-JSON de gmail-config.", 1);
  }
  // 'queries' (janela incremental); cai p/ 'query' unica em versoes antigas do Edge.
  let queries = Array.isArray(json?.queries)
    ? json.queries.filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim())
    : [];
  if (queries.length === 0 && typeof json?.query === "string" && json.query.trim()) {
    queries = [json.query.trim()];
  }
  if (queries.length === 0) fail("gmail-config nao devolveu nenhuma query.", 1);
  queries.forEach((q, i) => console.log(`Query ${i + 1}/${queries.length} do cockpit: "${q}".`));
  return queries;
}

/**
 * Abre a execucao da coleta no banco (via Edge gmail-execucao). Devolve o
 * execucao_id, ou null se a fonte ja estiver coletando (lock-por-fonte) — caso
 * em que o runner aborta sem rodar coleta duplicada.
 */
async function abrirExecucao() {
  const res = await fetch(EXECUCAO_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ action: "abrir", gatilho: GATILHO }),
  });
  const text = await res.text();
  if (!res.ok) {
    fail(`gmail-execucao (abrir) falhou (${res.status}): ${text.slice(0, 300)}`, 1);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    fail("resposta nao-JSON de gmail-execucao (abrir).", 1);
  }
  if (json?.ja_em_andamento) {
    console.log(`Ja ha uma coleta do Gmail em andamento (execucao ${json.execucao_id}). Abortando.`);
    return null;
  }
  console.log(`Execucao aberta: ${json?.execucao_id}.`);
  return json?.execucao_id ?? null;
}

/** Fecha a execucao (status final + contagens). Best-effort: nao derruba o run. */
async function fecharExecucao(execId, status, total, sucesso, erro, novos = 0) {
  if (!execId) return;
  try {
    const res = await fetch(EXECUCAO_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ action: "fechar", execucao_id: execId, status, total, sucesso, erro, novos }),
    });
    if (!res.ok) {
      console.error(`AVISO: gmail-execucao (fechar) falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`AVISO: falha ao fechar a execucao: ${err?.message ?? err}`);
  }
}

/** Itens (corpo + anexos) de uma mensagem ja carregada. */
function itensDaMensagem(message) {
  const { threadId, corpo, anexos } = extrairConteudo(message);
  const itens = [];
  if (corpo) {
    itens.push({
      message_id: message.id,
      thread_id: threadId,
      tipo: "corpo",
      nome: NOME_CORPO,
      extensao: "txt",
    });
  }
  for (const a of anexos) {
    if (!a.attachment_id || !a.nome) continue;
    itens.push({
      message_id: message.id,
      thread_id: threadId,
      tipo: "anexo",
      nome: a.nome,
      attachment_id: a.attachment_id,
      extensao: a.extensao,
    });
  }
  return itens;
}

/** Empurra itens ao Edge em lotes. Devolve total inserido/reaberto. */
async function enfileirar(itens) {
  let inseridos = 0;
  for (let i = 0; i < itens.length; i += LOTE) {
    const lote = itens.slice(i, i + LOTE);
    const res = await fetch(DESCOBRIR_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ fonte: "gmail", itens: lote }),
    });
    const text = await res.text();
    if (!res.ok) {
      fail(`documentos-descobrir falhou no lote ${i / LOTE + 1} (${res.status}): ${text.slice(0, 300)}`, 1);
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      // mantem text cru.
    }
    const n = Number(json?.inseridos);
    if (Number.isFinite(n)) inseridos += n;
    console.log(`  lote ${i / LOTE + 1}: ${lote.length} item(ns) -> novos ${json?.inseridos ?? "?"}`);
  }
  return inseridos;
}

async function main() {
  // Registra a execucao ANTES da coleta (lock-por-fonte no Edge). Se a fonte ja
  // coleta, execId vem null e o run aborta sem duplicar.
  const execId = await abrirExecucao();
  if (execId === null) return;

  try {
    const queries = await resolverQueries();
    // Varre cada query da janela (NOVOS + ANTIGOS) deduplicando por message id —
    // a borda de overlap faz NOVOS/ANTIGOS retornarem mensagens em comum.
    const vistos = new Set();
    const mensagens = [];
    for (const q of queries) {
      const lote = await listarMensagens(q, { max: MAX });
      for (const m of lote) {
        if (vistos.has(m.id)) continue;
        vistos.add(m.id);
        mensagens.push(m);
        if (mensagens.length >= MAX) break;
      }
      if (mensagens.length >= MAX) break;
    }
    if (mensagens.length === 0) {
      console.log("Nenhuma mensagem casou a(s) query(s). Nada a descobrir.");
      await fecharExecucao(execId, "concluida", 0, 0, 0);
      return;
    }
    console.log(`${mensagens.length} mensagem(ns) unica(s) a processar.`);

    // Monta os itens varrendo cada mensagem (corpo + anexos). Acumula e enfileira
    // em lotes — a fila e idempotente por (fonte, message_id, nome), entao
    // re-rodar nao duplica (email e imutavel).
    const itens = [];
    let processadas = 0;
    let falhas = 0;
    for (const { id } of mensagens) {
      // Tolerancia por mensagem: uma falha transitoria do Gmail (ex: 500
      // "Internal error") NAO pode abortar a coleta inteira. Registra, pula e
      // segue — a mensagem reentra na proxima coleta (overlap da janela). Sem
      // isso, uma unica mensagem-veneno trava a fonte (marcas so avancam em
      // 'concluida', entao a janela re-lista e re-morre toda hora).
      processadas += 1;
      try {
        const msg = await obterMensagem(id);
        const novos = itensDaMensagem(msg);
        itens.push(...novos);
        console.error(`[mensagem ${processadas}/${mensagens.length}] ${id}: ${novos.length} item(ns)`);
      } catch (err) {
        falhas += 1;
        console.error(
          `[mensagem ${processadas}/${mensagens.length}] ${id}: FALHA (pulada) -> ${err?.message ?? err}`,
        );
      }
    }

    const inseridos = await enfileirar(itens);
    console.log(
      `Descoberta Gmail concluida. Mensagens=${processadas}, falhas=${falhas}, itens=${itens.length}, novos=${inseridos}.`,
    );
    // Os itens varridos foram enfileirados -> processados com sucesso = total de
    // itens. `falhas` = mensagens que nao puderam ser lidas (serao tentadas de
    // novo na proxima coleta). `novos` = itens ineditos apos dedup da fila.
    await fecharExecucao(execId, "concluida", itens.length, itens.length, falhas, inseridos);
  } catch (err) {
    // Fecha a execucao como 'erro' antes de propagar (libera o lock-por-fonte).
    await fecharExecucao(execId, "erro", 0, 0, 0);
    throw err;
  }
}

main().catch((err) => fail(err?.message ?? String(err), 1));
