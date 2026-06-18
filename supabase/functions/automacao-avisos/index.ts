// =====================================================================
// Edge Function: automacao-avisos  (cockpit - listagem da triagem)
//   -> GET /automacao-avisos
//
// Lista TODOS os avisos JA triados (triagem_veredito IS NOT NULL), inclusive
// `lixo` (nunca oculta lixo na visao geral), com filtros de veredito e a visao
// "lixeira" (na_lixeira = true, dentro da carencia). Contrato 3.2.3 (RF-15..17,
// US-08/09/10).
//
// Por item, alem do estado vigente em `avisos` (veredito/confianca/lixeira/
// reabilitado), traz `motivo`, `produto_candidato` e `feedback_humano` da
// DECISAO VIGENTE (ultima linha de triagem_decisoes do aviso) e calcula
// `descarte_previsto_em` = na_lixeira_em + dias_carencia (config_automacao).
//
// Autorizacao na borda (US-21): requireAuthorizedUser -> 401 sem sessao, 403
// fora da allowlist. A leitura corre com service_role apos a borda autorizar
// (tabelas de triagem ficam fora das views lia.*, SEC-3).
// =====================================================================

import { handleCorsPreflight } from "../_shared/cors.ts";
import { assertMethod, errorResponse, jsonResponse } from "../_shared/http.ts";
import { getEnv } from "../_shared/env.ts";
import { requireAuthorizedUser } from "../_shared/auth.ts";
import { createServiceClient } from "../_shared/supabase.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

const FUNCTION_SEGMENT = "automacao-avisos";

const DEFAULT_LIMITE = 50;
const MIN_LIMITE = 1;
const MAX_LIMITE = 100;

const VEREDITOS = new Set(["util", "duvida", "lixo", "todos"]);

/** Item da listagem (contrato 3.2.3). */
interface AvisoTriadoItem {
  aviso_id: string;
  objeto: string;
  orgao: string;
  uf: string;
  data: string | null;
  veredito: string | null;
  confianca: number | null;
  motivo: string | null;
  produto_candidato: string | null;
  feedback_humano: string | null;
  na_lixeira: boolean;
  na_lixeira_em: string | null;
  descarte_previsto_em: string | null;
  reabilitado: boolean;
}

/** Linha de avisos lida (com aliases de uf via payload_bruto). */
interface AvisoRow {
  id: string;
  objeto: string | null;
  orgao: string | null;
  data_final: string | null;
  data_publicacao: string | null;
  data_captura: string | null;
  triagem_veredito: string | null;
  triagem_confianca: number | string | null;
  triagem_em: string | null;
  reabilitado: boolean | null;
  na_lixeira: boolean | null;
  na_lixeira_em: string | null;
  uf_direct: string | null;
  uf_estado: string | null;
  uf_sigla: string | null;
}

/** Recorte da decisao vigente usado na listagem. */
interface DecisaoRow {
  aviso_id: string;
  motivo: string | null;
  produto_candidato_nome: string | null;
  feedback_humano: string | null;
  decidido_em: string;
}

/** Normaliza `limite`: default 50, faixa [1, 100] (cap, nao rejeita). */
function normalizeLimite(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMITE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < MIN_LIMITE) {
    return DEFAULT_LIMITE;
  }
  return Math.min(parsed, MAX_LIMITE);
}

/** Resolve a UF a partir dos aliases extraidos do payload_bruto. */
function resolveUf(aviso: AvisoRow): string {
  for (const c of [aviso.uf_direct, aviso.uf_estado, aviso.uf_sigla]) {
    const v = (c ?? "").trim();
    if (v !== "") return v;
  }
  return "";
}

/**
 * Fila: avisos aguardando triagem. Mesmos criterios da esteira
 * (selectAvisosElegiveis): status_indexacao='indexado', reabilitado=false e
 * triagem_veredito IS NULL, em ordem FIFO (data_captura asc, id asc). Devolve
 * a pagina + `total` (count exato da fila inteira, para o badge "N aguardando").
 */
async function listarFila(
  db: ServiceClient,
  selectCols: string,
  limite: number,
  cursor: string | null,
): Promise<Response> {
  // Total da fila inteira (badge), independente da pagina/cursor.
  const { count, error: countError } = await db
    .from("avisos")
    .select("id", { count: "exact", head: true })
    .eq("status_indexacao", "indexado")
    .eq("reabilitado", false)
    .is("triagem_veredito", null);
  if (countError) {
    throw new Error(`falha ao contar a fila: ${countError.message}`);
  }

  let query = db
    .from("avisos")
    .select(selectCols)
    .eq("status_indexacao", "indexado")
    .eq("reabilitado", false)
    .is("triagem_veredito", null);

  // Keyset por cursor (uuid): retoma apos o aviso apontado, na ordem FIFO
  // (data_captura asc, id asc). Cursor desconhecido => recomeca do inicio.
  if (cursor) {
    const { data: cursorRow } = await db
      .from("avisos")
      .select("data_captura")
      .eq("id", cursor)
      .maybeSingle();
    const cursorCaptura = cursorRow?.data_captura as string | undefined;
    if (cursorCaptura) {
      query = query.or(
        `data_captura.gt."${cursorCaptura}",` +
          `and(data_captura.eq."${cursorCaptura}",id.gt."${cursor}")`,
      );
    }
  }

  const { data, error } = await query
    .order("data_captura", { ascending: true })
    .order("id", { ascending: true })
    .limit(limite);
  if (error) {
    throw new Error(`falha ao listar a fila: ${error.message}`);
  }

  const avisos = (data ?? []) as unknown as AvisoRow[];
  const itens: AvisoTriadoItem[] = avisos.map((aviso) => ({
    aviso_id: aviso.id,
    objeto: aviso.objeto ?? "",
    orgao: aviso.orgao ?? "",
    uf: resolveUf(aviso),
    // Fila mostra a data de ABERTURA dos lances = data_final das propostas
    // (encerramento do envio -> abre a disputa), nao a captura/publicacao.
    // A ordenacao da fila segue FIFO por data_captura.
    data: aviso.data_final ?? null,
    veredito: null,
    confianca: null,
    motivo: null,
    produto_candidato: null,
    feedback_humano: null,
    na_lixeira: false,
    na_lixeira_em: null,
    descarte_previsto_em: null,
    reabilitado: false,
  }));

  const nextCursor = itens.length === limite ? itens[itens.length - 1].aviso_id : null;

  return jsonResponse({ itens, total: count ?? 0, next_cursor: nextCursor }, 200);
}

/** descarte_previsto_em = na_lixeira_em + dias_carencia (ou null). */
function calcDescartePrevisto(naLixeiraEm: string | null, diasCarencia: number): string | null {
  if (!naLixeiraEm) return null;
  const base = Date.parse(naLixeiraEm);
  if (!Number.isFinite(base)) return null;
  return new Date(base + diasCarencia * 86_400_000).toISOString();
}

/** Le dias_carencia + descarte_fisico_ligado da config singleton. */
async function loadConfig(
  db: ServiceClient,
): Promise<{ diasCarencia: number; descarteFisicoLigado: boolean }> {
  const { data, error } = await db
    .from("config_automacao")
    .select("dias_carencia, descarte_fisico_ligado")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`falha ao ler config_automacao: ${error.message}`);
  }
  const dias = Number(data?.dias_carencia);
  return {
    diasCarencia: Number.isFinite(dias) && dias >= 1 ? Math.trunc(dias) : 30,
    descarteFisicoLigado: data?.descarte_fisico_ligado === true,
  };
}

/**
 * Mapa aviso_id -> decisao VIGENTE (ultima por decidido_em). A query ordena
 * desc, e o primeiro registro visto por aviso e o mais recente.
 */
async function loadDecisoesVigentes(
  db: ServiceClient,
  avisoIds: string[],
): Promise<Map<string, DecisaoRow>> {
  const map = new Map<string, DecisaoRow>();
  if (avisoIds.length === 0) return map;

  const { data, error } = await db
    .from("triagem_decisoes")
    .select("aviso_id, motivo, produto_candidato_nome, feedback_humano, decidido_em")
    .in("aviso_id", avisoIds)
    .order("decidido_em", { ascending: false });
  if (error) {
    throw new Error(`falha ao ler triagem_decisoes: ${error.message}`);
  }
  for (const row of (data ?? []) as DecisaoRow[]) {
    if (!map.has(row.aviso_id)) map.set(row.aviso_id, row);
  }
  return map;
}

async function handler(req: Request): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    assertMethod(req, "GET");

    // Autorizacao na borda: 401 sem sessao, 403 fora da allowlist.
    await requireAuthorizedUser(req);

    const url = new URL(req.url);
    const veredito = (url.searchParams.get("veredito") ?? "todos").toLowerCase();
    const vereditoFiltro = VEREDITOS.has(veredito) ? veredito : "todos";
    const lixeira = url.searchParams.get("lixeira") === "true";
    const fila = url.searchParams.get("fila") === "true";
    const limite = normalizeLimite(url.searchParams.get("limite"));
    const cursor = url.searchParams.get("cursor");

    const db = createServiceClient();

    const selectCols = "id, objeto, orgao, data_final, data_publicacao, data_captura, " +
      "triagem_veredito, triagem_confianca, triagem_em, reabilitado, " +
      "na_lixeira, na_lixeira_em, " +
      "uf_direct:payload_bruto->>uf, uf_estado:payload_bruto->>estado, " +
      "uf_sigla:payload_bruto->>siglaUf";

    // Fila: avisos aguardando triagem (ainda sem veredito). Ramo proprio,
    // ortogonal a listagem de triados/lixeira.
    if (fila) {
      return await listarFila(db, selectCols, limite, cursor);
    }

    // Avisos JA triados (nunca oculta lixo na visao geral).
    let query = db
      .from("avisos")
      .select(selectCols)
      .not("triagem_veredito", "is", null);

    if (vereditoFiltro !== "todos") {
      query = query.eq("triagem_veredito", vereditoFiltro);
    }
    // Visao lixeira: apenas os avisos atualmente na lixeira (na carencia).
    if (lixeira) {
      query = query.eq("na_lixeira", true);
    }

    // Keyset por cursor (uuid): retoma apos o aviso apontado, na ordem
    // (triagem_em desc, id desc). Cursor desconhecido => recomeca do inicio.
    if (cursor) {
      const { data: cursorRow } = await db
        .from("avisos")
        .select("triagem_em")
        .eq("id", cursor)
        .maybeSingle();
      const cursorEm = cursorRow?.triagem_em as string | undefined;
      if (cursorEm) {
        query = query.or(
          `triagem_em.lt."${cursorEm}",` +
            `and(triagem_em.eq."${cursorEm}",id.lt."${cursor}")`,
        );
      }
    }

    const { data, error } = await query
      .order("triagem_em", { ascending: false })
      .order("id", { ascending: false })
      .limit(limite);
    if (error) {
      throw new Error(`falha ao listar avisos triados: ${error.message}`);
    }

    // Aliases por arrow-operator quebram a inferencia do PostgREST -> cast.
    const avisos = (data ?? []) as unknown as AvisoRow[];

    const [{ diasCarencia, descarteFisicoLigado }, decisoes] = await Promise.all([
      loadConfig(db),
      loadDecisoesVigentes(db, avisos.map((a) => a.id)),
    ]);

    const itens: AvisoTriadoItem[] = avisos.map((aviso) => {
      const dec = decisoes.get(aviso.id);
      const confianca = aviso.triagem_confianca == null ? null : Number(aviso.triagem_confianca);
      return {
        aviso_id: aviso.id,
        objeto: aviso.objeto ?? "",
        orgao: aviso.orgao ?? "",
        uf: resolveUf(aviso),
        data: aviso.data_publicacao ?? aviso.data_captura ?? null,
        veredito: aviso.triagem_veredito ?? null,
        confianca: confianca != null && Number.isFinite(confianca) ? confianca : null,
        motivo: dec?.motivo ?? null,
        produto_candidato: dec?.produto_candidato_nome ?? null,
        feedback_humano: dec?.feedback_humano ?? null,
        na_lixeira: aviso.na_lixeira === true,
        na_lixeira_em: aviso.na_lixeira_em ?? null,
        descarte_previsto_em: calcDescartePrevisto(aviso.na_lixeira_em, diasCarencia),
        reabilitado: aviso.reabilitado === true,
      };
    });

    const nextCursor = itens.length === limite ? itens[itens.length - 1].aviso_id : null;

    return jsonResponse(
      {
        itens,
        descarte_fisico_ligado: descarteFisicoLigado,
        dias_carencia: diasCarencia,
        next_cursor: nextCursor,
      },
      200,
    );
  } catch (err) {
    return await errorResponse(err, { fn: FUNCTION_SEGMENT });
  }
}

// Validacao de env no startup: falha cedo se faltar configuracao obrigatoria.
getEnv();

Deno.serve(handler);
