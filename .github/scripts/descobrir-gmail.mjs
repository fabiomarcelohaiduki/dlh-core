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

function headers() {
  const h = { "Content-Type": "application/json", "X-Cron-Secret": CRON_SECRET };
  if (ANON) {
    h["apikey"] = ANON;
    h["Authorization"] = `Bearer ${ANON}`;
  }
  return h;
}

/** Resolve a query: override do workflow OU a montada pelo Edge (cockpit). */
async function resolverQuery() {
  if (QUERY_OVERRIDE) {
    console.log(`Override GMAIL_QUERY: usando query crua "${QUERY_OVERRIDE}".`);
    return QUERY_OVERRIDE;
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
  const query = typeof json?.query === "string" ? json.query.trim() : "";
  if (!query) fail("gmail-config nao devolveu uma query.", 1);
  console.log(`Query montada pelo cockpit: "${query}".`);
  return query;
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
  const query = await resolverQuery();
  const mensagens = await listarMensagens(query, { max: MAX });
  if (mensagens.length === 0) {
    console.log("Nenhuma mensagem casou a query. Nada a descobrir.");
    return;
  }
  console.log(`${mensagens.length} mensagem(ns) a processar.`);

  // Monta os itens varrendo cada mensagem (corpo + anexos). Acumula e enfileira
  // em lotes — a fila e idempotente por (fonte, message_id, nome), entao
  // re-rodar nao duplica (email e imutavel).
  const itens = [];
  let processadas = 0;
  for (const { id } of mensagens) {
    const msg = await obterMensagem(id);
    const novos = itensDaMensagem(msg);
    itens.push(...novos);
    processadas += 1;
    console.error(`[mensagem ${processadas}/${mensagens.length}] ${id}: ${novos.length} item(ns)`);
  }

  const inseridos = await enfileirar(itens);
  console.log(
    `Descoberta Gmail concluida. Mensagens=${processadas}, itens=${itens.length}, novos=${inseridos}.`,
  );
}

main().catch((err) => fail(err?.message ?? String(err), 1));
