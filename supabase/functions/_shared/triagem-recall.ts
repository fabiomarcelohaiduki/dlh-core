// =====================================================================
// _shared/triagem-recall.ts
//
// Nucleo deterministico do RECALL DO EFFECTI (validador B1), extraido de
// v1-triagem-veredito para ser reutilizado por outras Edges (ex.: o
// read-only v1-triagem-recall-check, que apenas DIAGNOSTICA o furo de
// recall sem escrever veredito). O comportamento e identico ao que rodava
// embutido na Edge de veredito — este arquivo so muda o lugar do codigo,
// nao a logica.
//
// O piso itensEdital sao os itens que SABIDAMENTE existem no edital (casaram
// a palavra do perfil). A lista-ANCORA completa vem do PAINEL WEB (/all)
// quando a credencial esta configurada; fail-open ao subset itensEdital.
// Casamento tolerante (numero OU normDesc) contra os itens JA extraidos.
// =====================================================================

import { createServiceClient } from "./supabase.ts";
import { normDesc } from "./normalizar.ts";
import { coletarItensPainel } from "./effecti-painel.ts";
import { errorMessage, recordIngestErro } from "./ingest-errors.ts";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** itensEdital do payload Effecti = subconjunto que casou as palavras-chave. */
export interface ItensEditalRow {
  item?: number | string | null;
  produtoLicitadoSemTags?: string | null;
}

/** Indice dos itens JA extraidos do aviso (numero + descricao normalizada). */
export interface ItensIndex {
  numeros: Set<number>;
  descs: Set<string>;
  total: number;
}

// Snapshot da descricao na fila de suspeitas: limita para a fila ficar leve.
const SNAPSHOT_DESC_MAX = 2000;

// Estados de extracao de TEXTO (documento_vinculos.status_extracao) com texto
// aproveitavel para extrair itens — espelha STATUS_EXTRACAO_COM_TEXTO da fila.
// So docs com texto entram no gate: docs sem texto nunca poderao ter itens
// estruturados e bloquear lixo neles seria eterno.
export const STATUS_EXTRACAO_COM_TEXTO = ["extraido", "herdado", "precisa_ocr"];

// ---------------------------------------------------------------------
// Validador de RECALL DO EFFECTI (deterministico, per-AVISO — B1). O piso
// itensEdital sao os itens que SABIDAMENTE existem no edital (casaram a palavra
// do perfil). Se algum nao aparece em NENHUM documento do aviso, a extracao
// esta incompleta -> rebaixa o veredito + enfileira. Agrega TODOS os docs por
// effecti_id (T7b): um item pode estar em qualquer documento do aviso. So
// consulta o banco quando ha piso a validar.
// ---------------------------------------------------------------------

export async function loadItensIndexDoAviso(db: ServiceClient, effectiId: string): Promise<ItensIndex> {
  const vazio: ItensIndex = { numeros: new Set(), descs: new Set(), total: 0 };
  const eid = (effectiId ?? "").trim();
  if (eid === "") return vazio;

  // Documentos do aviso (por effecti_id) com texto aproveitavel.
  const { data: vinculos, error: vincErr } = await db
    .from("documento_vinculos")
    .select("documento_id")
    .eq("fonte", "effecti")
    .eq("registro_origem_id", eid)
    .in("status_extracao", STATUS_EXTRACAO_COM_TEXTO);
  if (vincErr) {
    throw new Error(`falha ao ler documento_vinculos (recall effecti): ${vincErr.message}`);
  }
  const docIds = [
    ...new Set((vinculos ?? []).map((v) => v.documento_id as string).filter(Boolean)),
  ];
  if (docIds.length === 0) return vazio;

  // Itens de TODOS esses documentos, paginado (recall total: o teto de 1000 do
  // PostgREST truncaria itens em silencio e geraria faltante falso).
  const numeros = new Set<number>();
  const descs = new Set<string>();
  let total = 0;
  const PAGE = 1000;
  for (let from = 0;; from += PAGE) {
    const { data, error } = await db
      .from("documento_itens")
      .select("item_numero, descricao")
      .in("documento_id", docIds)
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error(`falha ao ler documento_itens (recall effecti): ${error.message}`);
    }
    const batch = (data ?? []) as { item_numero: string | null; descricao: string }[];
    for (const it of batch) {
      total++;
      const raw = (it.item_numero ?? "").trim();
      if (/^[0-9]+$/.test(raw)) numeros.add(Number(raw));
      const d = normDesc(it.descricao);
      if (d.length > 0) descs.add(d);
    }
    if (batch.length < PAGE) break;
  }
  return { numeros, descs, total };
}

/**
 * Itens do piso Effecti que NAO casam (nem por numero nem por descricao
 * normalizada) com nenhum item extraido do aviso. Casamento tolerante (mesma
 * chave de normDesc do badge do cockpit) para nao gerar falso negativo por
 * diferenca de redacao (decisao 2).
 */
export function faltantesDoEffecti(itensEdital: ItensEditalRow[], idx: ItensIndex): ItensEditalRow[] {
  const faltantes: ItensEditalRow[] = [];
  for (const e of itensEdital) {
    const n = typeof e.item === "number" ? e.item : Number(e.item);
    const porNumero = Number.isInteger(n) && idx.numeros.has(n);
    const d = normDesc(e.produtoLicitadoSemTags);
    const porDescricao = d.length > 0 && idx.descs.has(d);
    if (!porNumero && !porDescricao) faltantes.push(e);
  }
  return faltantes;
}

/**
 * Enfileira os itens do piso ausentes em documento_item_suspeitas(recall_effecti)
 * — delete-then-insert por aviso das pendentes (reconciliacao: uma re-triagem que
 * agora recupera o item limpa a suspeita antiga; curadas sobrevivem). Best-effort:
 * NUNCA derruba o veredito ja gravado.
 */
export async function enfileirarRecallEffecti(
  db: ServiceClient,
  avisoId: string,
  faltantes: ItensEditalRow[],
): Promise<void> {
  try {
    const { error: delErr } = await db
      .from("documento_item_suspeitas")
      .delete()
      .eq("aviso_id", avisoId)
      .eq("tipo", "recall_effecti")
      .eq("status", "pendente");
    if (delErr) {
      throw new Error(`falha ao limpar recall pendente: ${delErr.message}`);
    }
    if (faltantes.length === 0) return;
    const rows = faltantes.map((e) => ({
      aviso_id: avisoId,
      documento_id: null,
      documento_item_id: null,
      tipo: "recall_effecti",
      item_descricao: String(e.produtoLicitadoSemTags ?? "").slice(0, SNAPSHOT_DESC_MAX),
      numero_suspeito: e.item != null ? String(e.item) : null,
      motivo: "item do piso Effecti (itensEdital) ausente da extracao do aviso",
    }));
    const { error: insErr } = await db.from("documento_item_suspeitas").insert(rows);
    if (insErr) {
      throw new Error(`falha ao enfileirar recall effecti: ${insErr.message}`);
    }
  } catch (err) {
    await recordIngestErro(db, {
      avisoId,
      severidade: "media",
      etapa: "Persistencia",
      mensagem: `recall do Effecti nao enfileirado: ${errorMessage(err)}`,
    });
  }
}

/**
 * Resolve a lista-ANCORA de recall do Effecti. A API de integracao (token) so
 * devolve o SUBSET itensEdital (os itens que casaram a palavra-chave do perfil);
 * a lista COMPLETA numerada por edital vem do PAINEL WEB (/all). Quando a
 * credencial do painel esta configurada, a lista do /all SUBSTITUI o subset
 * (recall total). Fail-open: qualquer falha do painel (cred ausente, login
 * recusado, indisponibilidade, edital sem itens) cai de volta no subset — o
 * gate degrada para o comportamento anterior, NUNCA derruba o veredito.
 */
export async function resolverAncoraEffecti(
  effectiId: string | null,
  subset: ItensEditalRow[],
): Promise<{ itens: ItensEditalRow[]; origem: "painel" | "subset" }> {
  const eid = (effectiId ?? "").trim();
  if (eid === "") return { itens: subset, origem: "subset" };
  try {
    const coleta = await coletarItensPainel(eid);
    if (coleta.itens.length === 0) return { itens: subset, origem: "subset" };
    const itens: ItensEditalRow[] = coleta.itens.map((i) => ({
      item: i.item_numero,
      produtoLicitadoSemTags: i.descricao,
    }));
    return { itens, origem: "painel" };
  } catch {
    return { itens: subset, origem: "subset" };
  }
}
