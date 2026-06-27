// Coletor SERVER-SIDE da Lista Effecti (ancora do portal /all) -> aviso_itens_portal.
//
// Replica o que a Edge effecti-painel-itens faz (login no painel + GET /all +
// snapshot delete+insert), mas SEM o JWT do cockpit: roda via service-role pela
// conexao do .env.local. A credencial do painel sai do Vault por RPC
// (get_service_secret('EFFECTI_PAINEL_CRED'), SECURITY DEFINER) e a escrita usa a
// mesma conexao service-role. Serve de PASSO 0 do treino: sem ancora o extrator
// deterministico nao roda.
//
// A descricao do /all e GENERICA do portal (CATMAT) e os precos vem ZERADOS -- a
// ancora vale por item_numero + quantidade + unidade, NUNCA pela descricao.
//
// Uso:
//   node scripts/coletar-itens-portal.mjs --aviso 7574584 --dry
//   node scripts/coletar-itens-portal.mjs --aviso 7574584,7769244
//   node scripts/coletar-itens-portal.mjs --fila 10
//   node scripts/coletar-itens-portal.mjs --fila 10 --dry

import { readFileSync } from "node:fs";
import pg from "pg";

// --- argumentos -------------------------------------------------------------
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
function arg(nome) {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
}
const AVISOS_ARG = arg("--aviso");
const FILA_RAW = arg("--fila");
if (FILA_RAW !== undefined && !Number.isFinite(Number(FILA_RAW))) {
  console.error(`--fila precisa de um numero. Recebido: ${JSON.stringify(FILA_RAW)}`);
  process.exit(1);
}
const FILA_N = FILA_RAW !== undefined ? Math.max(1, Math.floor(Number(FILA_RAW))) : 0;
if (!AVISOS_ARG && !FILA_N) {
  console.error("Falta --aviso <id[,id...]> ou --fila <N>. Ex: --aviso 7574584 --dry");
  process.exit(1);
}

// --- conexao (le SUPABASE_DB_URL do .env.local) -----------------------------
function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const linha of txt.split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// --- painel Effecti (mesmas constantes da Edge _shared/effecti-painel.ts) ----
const PAINEL_BASE = "https://middleware.effecti.com.br";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const TIMEOUT_MS = 20000;

function limparDescricao(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/<\/?(?:em|mark)>/gi, "").replace(/\s+/g, " ").trim();
}

async function fetchComTimeout(url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Le a credencial {username,password} do Vault pela RPC service-role e troca por JWT.
async function loginPainel(c) {
  const { rows } = await c.query("SELECT public.get_service_secret($1) AS s", ["EFFECTI_PAINEL_CRED"]);
  const raw = rows[0]?.s;
  if (!raw) throw new Error("credencial EFFECTI_PAINEL_CRED ausente no Vault (cadastre em Fontes > Effecti)");
  let username, password;
  try {
    const p = JSON.parse(raw);
    username = p.username ?? "";
    password = p.password ?? "";
  } catch {
    throw new Error("credencial do painel ilegivel no Vault (esperado JSON {username,password})");
  }
  if (!username || !password) throw new Error("credencial do painel incompleta");

  const res = await fetchComTimeout(`${PAINEL_BASE}/users/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const credInvalida = res.status === 401 || res.status === 403;
    throw new Error(
      `login no painel Effecti falhou (HTTP ${res.status})` +
        (credInvalida ? " -- credencial EFFECTI_PAINEL_CRED invalida/expirada (recadastre em Fontes > Effecti)" : ""),
    );
  }
  const body = await res.json();
  const token = body.token ?? body.access_token;
  if (!token) throw new Error("login no painel nao devolveu token");
  return token;
}

// GET /all + normaliza (mesma logica de coletarItensPainel).
async function coletarItens(token, effectiId) {
  const res = await fetchComTimeout(
    `${PAINEL_BASE}/aviso/minhas/itens/edital/${encodeURIComponent(effectiId)}/all`,
    { headers: { authorization: `Bearer ${token}`, "user-agent": UA, accept: "application/json" } },
  );
  if (res.status === 404) return { naoEncontrado: true, itens: [], contigua: false };
  if (!res.ok) throw new Error(`/all falhou (HTTP ${res.status})`);

  const data = await res.json();
  const brutos = Array.isArray(data.items) ? data.items : [];
  // item_numero e NOT NULL inteiro no banco. id ilegivel (Number(it.id) NaN) gravado
  // estoura o INSERT e o ROLLBACK derruba o snapshot INTEIRO do aviso -> recall zerado.
  // Separa os ilegiveis em invalidos[] REPORTADO (nunca dropa em silencio, nunca grava
  // lixo); so item com numero inteiro segue para o snapshot.
  const validos = [];
  const invalidos = [];
  for (const b of brutos) {
    const it = b ?? {};
    const grupo = typeof it.group === "string" ? it.group.trim() : "";
    const numero = Number(it.id);
    const reg = {
      item_numero: numero,
      lote: grupo === "" ? null : grupo,
      descricao: limparDescricao(it.object),
      unidade: typeof it.unity === "string" && it.unity.trim() !== "" ? it.unity.trim() : null,
      quantidade: typeof it.amount === "number" ? it.amount : null,
    };
    if (Number.isInteger(numero)) validos.push(reg);
    else invalidos.push(`id=${JSON.stringify(it.id)} "${reg.descricao}"`);
  }
  // A /all do portal pode repetir a MESMA chave (lote,item_numero). Colapsa so a
  // duplicata EXATA (mesma descricao = mesmo slot, nao perde item); chave repetida
  // com descricao DIFERENTE vira conflito reportado (nunca resolve em silencio).
  const { unicos, conflitos } = dedupChave(validos);
  const numeros = unicos.map((i) => i.item_numero);
  const contigua = numeros.length > 0 && numeros.every((n, k) => n === k + 1);
  return { naoEncontrado: false, itens: unicos, conflitos, invalidos, contigua };
}

// Colapsa duplicata EXATA por chave (lote,item_numero) e separa conflitos. A ancora
// vale por item_numero+quantidade+unidade, entao "exata" exige bater descricao E
// quantidade E unidade -- divergencia em qualquer um vira conflito reportado (nunca
// colapsa em silencio uma qtde/unidade diferente sob a mesma chave).
function dedupChave(itens) {
  const vistos = new Map();
  const unicos = [];
  const conflitos = [];
  for (const i of itens) {
    const chave = `${i.lote ?? ""}|${i.item_numero}`;
    const prev = vistos.get(chave);
    if (prev === undefined) {
      vistos.set(chave, i);
      unicos.push(i);
    } else if (prev.descricao !== i.descricao || prev.quantidade !== i.quantidade || prev.unidade !== i.unidade) {
      conflitos.push(
        `[${chave}] {q:${prev.quantidade},u:${prev.unidade}} "${prev.descricao}" != {q:${i.quantidade},u:${i.unidade}} "${i.descricao}"`,
      );
    }
  }
  return { unicos, conflitos };
}

// Snapshot atomico por effecti_id (delete + insert), igual a Edge.
async function gravarSnapshot(c, effectiId, itens, contigua) {
  await c.query("BEGIN");
  try {
    await c.query("DELETE FROM public.aviso_itens_portal WHERE effecti_id=$1", [effectiId]);
    for (const i of itens) {
      await c.query(
        `INSERT INTO public.aviso_itens_portal
           (effecti_id, item_numero, lote, descricao, unidade, quantidade, contigua)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [effectiId, i.item_numero, i.lote, i.descricao, i.unidade, i.quantidade, contigua],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* sem tx aberta */ }
    throw e;
  }
}

// --fila N: avisos com docs effecti extraiveis (texto) ainda SEM ancora coletada.
async function selecionarFila(c, n) {
  const { rows } = await c.query(
    `SELECT DISTINCT a.effecti_id
       FROM public.avisos a
       JOIN public.documento_vinculos dv
         ON dv.fonte='effecti' AND dv.registro_origem_id = a.effecti_id
       JOIN public.documentos d ON d.id = dv.documento_id
       LEFT JOIN public.aviso_itens_portal p ON p.effecti_id = a.effecti_id
      WHERE p.effecti_id IS NULL
        AND coalesce(d.texto_chars,0) > 0
        AND d.itens_status IN ('pendente','erro')
      ORDER BY a.effecti_id
      LIMIT $1`,
    [n],
  );
  return rows.map((r) => String(r.effecti_id));
}

// --- main -------------------------------------------------------------------
async function main() {
  const env = loadEnv();
  const url = env.SUPABASE_DB_URL || env.DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DB_URL ausente no .env.local");
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    let ids;
    if (AVISOS_ARG) {
      ids = AVISOS_ARG.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      ids = await selecionarFila(c, FILA_N);
      if (!ids.length) { console.log("Fila vazia: nenhum aviso sem ancora com docs extraiveis."); return; }
    }
    console.log(`Coletar ancora de ${ids.length} aviso(s)${DRY ? " | modo DRY" : ""}: ${ids.join(", ")}`);

    const token = await loginPainel(c);

    let okCount = 0;
    for (const id of ids) {
      try {
        const r = await coletarItens(token, id);
        if (r.naoEncontrado) { console.log(`- ${id}: edital nao encontrado no painel (404)`); continue; }
        const tag = `${r.itens.length} itens${r.contigua ? " (contigua)" : " (NAO contigua)"}`;
        if (r.conflitos.length) {
          console.log(`- ${id}: CONFLITO de descricao na mesma chave (revisar): ${r.conflitos.join(" ; ")}`);
        }
        if (r.invalidos.length) {
          console.log(`- ${id}: ${r.invalidos.length} item(ns) com id ILEGIVEL (fora do snapshot, revisar): ${r.invalidos.join(" ; ")}`);
        }
        if (DRY) {
          console.log(`- ${id}: ${tag} | DRY (nao gravado)`);
        } else {
          await gravarSnapshot(c, id, r.itens, r.contigua);
          okCount += 1;
          console.log(`- ${id}: ${tag} | gravado`);
        }
      } catch (e) {
        console.log(`- ${id}: FALHA ${e.message}`);
      }
    }

    console.log("\n--- resumo ---");
    if (DRY) console.log("DRY: nada gravado.");
    else console.log(`snapshots gravados: ${okCount}/${ids.length}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
