// =====================================================================
// _shared/backtest-recall.ts
// Mede o RECALL da triagem em MODO SOMBRA, antes de habilitar o descarte
// fisico (gate do interruptor descarte_fisico_ligado). Contrato 3.2.9
// (RF-26, US-16, SEC-2).
//
// Cruza o estado vigente da triagem (avisos.triagem_veredito, preservado por
// triagem_decisoes) contra os processos REAIS do Nomus (verdade-fundamental
// "deveria ser util") lidos pelo conector existente (SO LEITURA). Para os
// avisos que viraram processo real no Nomus, calcula quantos a triagem NAO
// mandaria para a lixeira (veredito in ('util','duvida')).
//
//   recall = preservados_pela_triagem / casados_com_aviso
//
// Chave de match no V1 (E9): avisos.nomus_processo_ref ainda e null (escrita no
// Nomus e ONDA 2), entao o join usa o NUMERO DA LICITACAO/EDITAL: avisos.effecti_id
// (idLicitacao do Effecti) e os numeros de edital extraidos do payload, casados
// contra o numero do edital carregado pelo processo Nomus (nome/descricao/payload).
//
// Operacao 100% de leitura, idempotente e SEM efeito colateral: nao liga o
// interruptor, nao descarta, nao cadastra. Falha de leitura do Nomus e
// sinalizada com BacktestNomusError (a borda responde 502 com recall: null).
// =====================================================================

import { type SupabaseClient } from "@supabase/supabase-js";
import { createConnector } from "./effecti-connector.ts";
import { type NomusConnector } from "./nomus-connector.ts";
import { getFonteByTipo, getFonteSecret } from "./vault.ts";
import { type CollectedRecord } from "./collected.ts";

/** Teto de paginas lidas do Nomus por execucao (limita o wall-clock do Edge). */
const MAX_PAGINAS_NOMUS = 60;

/** Teto de amostras de falso-descarte (recall miss) retornadas. */
const MAX_AMOSTRAS = 20;

/** Falha de leitura do Nomus (best-effort): a borda responde 502/recall null. */
export class BacktestNomusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestNomusError";
  }
}

export interface BacktestPeriodo {
  desde: Date;
  ate: Date;
}

export interface FalsoDescarteAmostra {
  aviso_id: string;
  objeto: string;
  veredito: string;
  confianca: number | null;
  nomus_processo_ref: string | null;
}

export interface BacktestResult {
  processos_nomus_reais: number;
  casados_com_aviso: number;
  preservados_pela_triagem: number;
  descartados_indevidamente: number;
  recall: number | null;
  amostras_falso_descarte: FalsoDescarteAmostra[];
}

interface AvisoTriado {
  id: string;
  effecti_id: string;
  objeto: string | null;
  triagem_veredito: string | null;
  triagem_confianca: number | string | null;
  nomus_processo_ref: string | null;
  payload_bruto: unknown;
}

// ---------------------------------------------------------------------
// Extracao de chaves de match (numero de edital / licitacao)
// ---------------------------------------------------------------------

/** Campos que costumam carregar o numero do edital/licitacao/processo. */
const CAMPOS_EDITAL = [
  "numeroEdital",
  "edital",
  "numeroLicitacao",
  "numeroProcesso",
  "numeroCompra",
  "numeroControlePNCP",
  "processo",
  "licitacao",
  "numero",
];

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Deriva chaves canonicas de edital a partir de um texto livre: padroes
 * "NNNN/AAAA" (ano normalizado a 4 digitos) e sequencias longas de digitos
 * (>= 6, ex.: codigos PNCP). Tokens curtos/ambiguos (anos soltos) sao ignorados
 * para nao gerar falsos casamentos.
 */
function chavesDeTexto(texto: string): string[] {
  const out: string[] = [];

  const editalRe = /(\d{1,6})\s*[\/.\-]\s*(\d{2,4})/g;
  let m: RegExpExecArray | null;
  while ((m = editalRe.exec(texto)) !== null) {
    const num = String(Number(m[1]));
    const ano = m[2].length === 2 ? `20${m[2]}` : m[2];
    out.push(`ed:${num}/${ano}`);
  }

  const digitosRe = /\d{6,}/g;
  while ((m = digitosRe.exec(texto)) !== null) {
    out.push(`num:${m[0]}`);
  }

  return out;
}

/** Reune as chaves de um conjunto de valores textuais candidatos. */
function chavesDeValores(valores: Array<string | null>): Set<string> {
  const keys = new Set<string>();
  for (const v of valores) {
    if (!v) continue;
    for (const k of chavesDeTexto(v)) keys.add(k);
  }
  return keys;
}

/** Le os campos candidatos de edital de um objeto bruto (nivel raso). */
function valoresCandidatos(payload: unknown): Array<string | null> {
  if (typeof payload !== "object" || payload === null) return [];
  const obj = payload as Record<string, unknown>;
  return CAMPOS_EDITAL.map((k) => asString(obj[k]));
}

/** Chaves de match de um aviso (numero da licitacao + editais do payload). */
function chavesDoAviso(aviso: AvisoTriado): Set<string> {
  const keys = chavesDeValores([
    aviso.effecti_id,
    aviso.objeto,
    ...valoresCandidatos(aviso.payload_bruto),
  ]);
  // O proprio idLicitacao do Effecti como numero (chave id_licitacao, E9).
  const idNum = Number(aviso.effecti_id);
  if (Number.isFinite(idNum)) keys.add(`num:${idNum}`);
  // Referencia direta ao processo Nomus quando ja existir (ONDA 2).
  const ref = (aviso.nomus_processo_ref ?? "").trim();
  if (ref !== "") keys.add(`ref:${ref}`);
  return keys;
}

/** Chaves de match de um processo Nomus (editais no nome/descricao/payload). */
function chavesDoProcesso(rec: CollectedRecord): Set<string> {
  const keys = chavesDeValores([
    rec.nome,
    rec.descricao,
    ...valoresCandidatos(rec.payload_bruto),
  ]);
  keys.add(`ref:${rec.nomus_id}`);
  return keys;
}

// ---------------------------------------------------------------------
// Leitura dos insumos
// ---------------------------------------------------------------------

/** Avisos JA triados no periodo (estado vigente preservado por triagem). */
async function loadAvisosTriados(
  db: SupabaseClient,
  periodo: BacktestPeriodo,
): Promise<AvisoTriado[]> {
  const { data, error } = await db
    .from("avisos")
    .select(
      "id, effecti_id, objeto, triagem_veredito, triagem_confianca, nomus_processo_ref, payload_bruto",
    )
    .not("triagem_veredito", "is", null)
    .gte("triagem_em", periodo.desde.toISOString())
    .lte("triagem_em", periodo.ate.toISOString())
    .limit(5_000);
  if (error) {
    throw new Error(`falha ao ler avisos triados: ${error.message}`);
  }
  return (data ?? []) as AvisoTriado[];
}

/** Verdade-fundamental: e a data de criacao do processo Nomus no periodo? */
function dentroDoPeriodo(iso: string | null, periodo: BacktestPeriodo): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= periodo.desde.getTime() && ms <= periodo.ate.getTime();
}

/**
 * Le os processos REAIS do Nomus no periodo via conector (SO LEITURA). Lanca
 * BacktestNomusError em qualquer falha de leitura (best-effort: 502/recall null).
 */
async function loadProcessosNomus(periodo: BacktestPeriodo): Promise<CollectedRecord[]> {
  let connector: NomusConnector;
  try {
    const fonte = await getFonteByTipo("nomus");
    const token = await getFonteSecret(fonte.id);
    if (!token) {
      throw new BacktestNomusError("credencial Nomus nao configurada");
    }
    connector = createConnector("nomus", {
      endpointBase: fonte.endpointBase,
      token,
    }) as NomusConnector;
  } catch (err) {
    if (err instanceof BacktestNomusError) throw err;
    throw new BacktestNomusError(
      `fonte Nomus indisponivel: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const processos: CollectedRecord[] = [];
  try {
    for (let pagina = 1; pagina <= MAX_PAGINAS_NOMUS; pagina++) {
      const { records, vazia } = await connector.collectPage(pagina, {
        sinceDate: periodo.desde,
        untilDate: periodo.ate,
      });
      if (vazia) break;
      for (const rec of records) {
        if (dentroDoPeriodo(rec.data_criacao, periodo)) processos.push(rec);
      }
    }
  } catch (err) {
    throw new BacktestNomusError(
      `falha ao ler processos do Nomus: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return processos;
}

// ---------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------

/** Vereditos que NAO mandam o aviso para a lixeira (preservados). */
const PRESERVA = new Set(["util", "duvida"]);

/**
 * Executa o backtest de recall no periodo. Cruza os avisos triados com os
 * processos reais do Nomus e devolve as metricas do contrato 3.2.9. NAO escreve
 * nada. Lanca BacktestNomusError se a leitura do Nomus falhar.
 */
export async function runBacktestRecall(
  db: SupabaseClient,
  periodo: BacktestPeriodo,
): Promise<BacktestResult> {
  const [avisos, processos] = await Promise.all([
    loadAvisosTriados(db, periodo),
    loadProcessosNomus(periodo),
  ]);

  // Indice chave -> aviso (primeiro vence; varios avisos podem compartilhar).
  const indice = new Map<string, AvisoTriado>();
  for (const aviso of avisos) {
    for (const key of chavesDoAviso(aviso)) {
      if (!indice.has(key)) indice.set(key, aviso);
    }
  }

  // Avisos que viraram processo real no Nomus (cada aviso conta uma unica vez).
  const casados = new Map<string, AvisoTriado>();
  for (const rec of processos) {
    for (const key of chavesDoProcesso(rec)) {
      const aviso = indice.get(key);
      if (aviso && !casados.has(aviso.id)) {
        casados.set(aviso.id, aviso);
        break;
      }
    }
  }

  let preservados = 0;
  let descartados = 0;
  const amostras: FalsoDescarteAmostra[] = [];

  for (const aviso of casados.values()) {
    const veredito = aviso.triagem_veredito ?? "";
    if (PRESERVA.has(veredito)) {
      preservados += 1;
    } else if (veredito === "lixo") {
      descartados += 1;
      if (amostras.length < MAX_AMOSTRAS) {
        const conf = aviso.triagem_confianca == null ? null : Number(aviso.triagem_confianca);
        amostras.push({
          aviso_id: aviso.id,
          objeto: aviso.objeto ?? "",
          veredito,
          confianca: conf != null && Number.isFinite(conf) ? conf : null,
          nomus_processo_ref: aviso.nomus_processo_ref ?? null,
        });
      }
    }
  }

  const casadosTotal = casados.size;
  const recall = casadosTotal > 0 ? preservados / casadosTotal : 0;

  return {
    processos_nomus_reais: processos.length,
    casados_com_aviso: casadosTotal,
    preservados_pela_triagem: preservados,
    descartados_indevidamente: descartados,
    recall,
    amostras_falso_descarte: amostras,
  };
}
