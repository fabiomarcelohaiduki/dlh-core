// =====================================================================
// _shared/effecti-painel.ts
// Coletor da lista COMPLETA de itens de um edital pelo PAINEL WEB da Effecti.
//
// A API de integracao (token) so devolve a SUBLISTA que casou por palavra-chave
// (payload_bruto.itensEdital). A lista numerada COMPLETA por edital vem do painel
// web via login programatico (usuario/senha -> JWT) no endpoint /all. Serve de
// ANCORA DE RECALL TOTAL na triagem (gate de recall): garantir que a extracao do
// PDF cobre todos os N itens. A descricao do /all e GENERICA do portal (com tags
// <em>/<mark> de match) e os precos vem ZERADOS -- por isso NAO e fonte de
// descricao fiel (a fiel vem do PDF), so de contagem/numeracao.
//
// Credencial: segredo de servico EFFECTI_PAINEL_CRED no Vault (JSON
// {username,password}), cadastrado pela tela de Fontes. Server-side only.
// =====================================================================

import { HttpError } from "./http.ts";
import { EFFECTI_PAINEL_CRED_KEY_NAME, getServiceSecret } from "./vault.ts";

const PAINEL_BASE = "https://middleware.effecti.com.br";
/** UA browser-like: alguns middlewares barram clientes sem User-Agent. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
/** Teto de espera por requisicao (login/all). undici nao impoe timeout sozinho. */
const TIMEOUT_MS = 20000;

/** Item normalizado da lista completa do painel (ancora de recall). */
export interface ItemPainelEffecti {
  /** Numero do item no edital (1-indexado, contiguo). */
  item_numero: number;
  /** Lote/grupo quando o edital divide por lotes; null quando nao ha. */
  lote: string | null;
  /** Descricao GENERICA do portal, sem as tags <em>/<mark> de match. */
  descricao: string;
  /** Unidade de fornecimento (ex: Unidade, Pacote). */
  unidade: string | null;
  /** Quantidade estimada. */
  quantidade: number | null;
}

/** Resultado do coletor: itens + metadados do edital no painel. */
export interface ColetaPainelEffecti {
  effecti_id: string;
  total: number;
  /** numeracao 1..N sem buracos/duplicatas (sinal de recall integro). */
  contigua: boolean;
  itens: ItemPainelEffecti[];
}

/** Remove as tags de realce <em>/<mark> e normaliza espacos da descricao. */
function limparDescricao(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<\/?(?:em|mark)>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** fetch com timeout por AbortController (login/all nao penduram o run). */
async function fetchComTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError"
      ? "tempo de resposta esgotado no painel Effecti"
      : "falha de conexao com o painel Effecti";
    throw new HttpError(502, "painel_effecti_indisponivel", msg);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Login programatico no painel: le a credencial do Vault e troca usuario/senha
 * por um JWT. Sem captcha. O JWT vale para a chamada subsequente do /all.
 */
async function loginPainel(): Promise<string> {
  const raw = await getServiceSecret(EFFECTI_PAINEL_CRED_KEY_NAME);
  if (!raw) {
    throw new HttpError(
      412,
      "painel_cred_ausente",
      "credencial do painel Effecti nao configurada (cadastre em Fontes > Effecti)",
    );
  }
  let username: string;
  let password: string;
  try {
    const parsed = JSON.parse(raw) as { username?: string; password?: string };
    username = parsed.username ?? "";
    password = parsed.password ?? "";
  } catch {
    throw new HttpError(500, "painel_cred_corrompida", "credencial do painel Effecti ilegivel no Vault");
  }
  if (!username || !password) {
    throw new HttpError(412, "painel_cred_ausente", "credencial do painel Effecti incompleta");
  }

  const res = await fetchComTimeout(`${PAINEL_BASE}/users/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(
      401,
      "painel_login_invalido",
      "login no painel Effecti recusado (usuario/senha invalidos ou expirados)",
    );
  }
  if (!res.ok) {
    throw new HttpError(502, "painel_login_falhou", `login no painel Effecti falhou (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (!token) {
    throw new HttpError(502, "painel_login_sem_token", "login no painel Effecti nao devolveu token");
  }
  return token;
}

/**
 * Coleta a lista COMPLETA de itens de um edital pelo painel web (recall total).
 * Faz login + GET /all, normaliza e devolve a lista numerada. Lanca HttpError
 * tipado em qualquer falha (credencial ausente, login recusado, indisponibilidade).
 */
export async function coletarItensPainel(effectiId: string): Promise<ColetaPainelEffecti> {
  const id = String(effectiId).trim();
  if (!id) {
    throw new HttpError(422, "effecti_id_invalido", "effecti_id e obrigatorio");
  }

  const token = await loginPainel();
  const res = await fetchComTimeout(
    `${PAINEL_BASE}/aviso/minhas/itens/edital/${encodeURIComponent(id)}/all`,
    { headers: { authorization: `Bearer ${token}`, "user-agent": UA, accept: "application/json" } },
  );
  if (res.status === 404) {
    throw new HttpError(404, "edital_nao_encontrado", `edital ${id} nao encontrado no painel Effecti`);
  }
  if (!res.ok) {
    throw new HttpError(502, "painel_all_falhou", `busca de itens no painel Effecti falhou (HTTP ${res.status})`);
  }

  const data = (await res.json()) as { items?: unknown[] };
  const brutos = Array.isArray(data.items) ? data.items : [];
  const itens: ItemPainelEffecti[] = brutos.map((b) => {
    const it = (b ?? {}) as Record<string, unknown>;
    const grupo = typeof it.group === "string" ? it.group.trim() : "";
    return {
      item_numero: Number(it.id),
      lote: grupo === "" ? null : grupo,
      descricao: limparDescricao(it.object),
      unidade: typeof it.unity === "string" && it.unity.trim() !== "" ? it.unity.trim() : null,
      quantidade: typeof it.amount === "number" ? it.amount : null,
    };
  });

  const numeros = itens.map((i) => i.item_numero);
  const contigua = numeros.length > 0 &&
    numeros.every((n, k) => n === k + 1);

  return { effecti_id: id, total: itens.length, contigua, itens };
}
