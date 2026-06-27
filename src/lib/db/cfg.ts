// =====================================================================
// Camada de dados (db/) — raiz de configuracao versionada (cfgRoot v=1) +
// migrador de leitura unica localStorage -> Supabase (SPEC 2.4.3 / delta-19 /
// D-DB-05).
//
// Principio (notas de arquitetura): Supabase e a FONTE DA VERDADE; o
// localStorage e apenas cache de UI anti-flash. No primeiro acesso autenticado
// o estado legado guardado no localStorage e importado UMA UNICA VEZ para o
// Supabase e as chaves legadas sao descartadas com `safeRemove`. A remocao de
// cada chave ocorre SOMENTE apos o upsert correspondente confirmar (EC-07):
// uma falha parcial preserva as chaves restantes para re-tentativa no proximo
// boot, sem perda de preferencia legada. Como as chaves sao removidas ao final,
// execucoes subsequentes nao reimportam nada (idempotencia natural).
//
// O writer de configuracao (`applyConfig`) e injetado pelo chamador
// (bootstrapConfiguracao) para evitar dependencia circular com configuracao.ts.
// =====================================================================

import { db, type TypedClient } from "@/lib/api/session";
import { upsertBlocoConfigRows } from "@/lib/db/bloco-config";
import { temaIdDeNome } from "@/lib/db/tema";
import type { BlocoBanda, BlocoConfigInsert, BlocoTipo, Densidade } from "@/types/database";
import type { Configuracao } from "@/types/domain";

// ---------------------------------------------------------------------
// cfgRoot — raiz versionada (v=1)
// ---------------------------------------------------------------------

/** Versao do contrato da raiz de configuracao (chave legada `dlh.cfg v:1`). */
export const CFG_VERSION = 1 as const;

/** Preferencias de UI que vivem (tambem) como cache no localStorage. */
export interface CfgPrefs {
  /** UUID do tema (null = padrao LionClaw). */
  temaId: string | null;
  densidade: Densidade;
  /** Pref puramente de UI (sem coluna no banco). */
  sidebarRecolhida: boolean;
  reduzirMovimento: boolean;
  highlightPendencias: boolean;
}

/** Raiz de configuracao canonica e versionada (v=1). */
export interface CfgRoot {
  v: typeof CFG_VERSION;
  prefs: CfgPrefs;
}

/** Retorna a raiz de configuracao default (v=1). */
export function cfgRoot(): CfgRoot {
  return {
    v: CFG_VERSION,
    prefs: {
      temaId: null,
      densidade: "confortavel",
      sidebarRecolhida: false,
      reduzirMovimento: false,
      highlightPendencias: true,
    },
  };
}

// ---------------------------------------------------------------------
// Migrador de leitura unica
// ---------------------------------------------------------------------

/** Chaves legadas do localStorage importadas e descartadas no primeiro acesso. */
export const LEGACY_KEYS = [
  "dlh.cfg",
  "dlh.cockpitcards",
  "dlh.cockpitwidgets",
  "dlh-theme",
] as const;

/** Aplica um patch parcial de configuracao (injetado por configuracao.ts). */
export type ConfigWriter = (patch: Partial<Configuracao>) => Promise<unknown>;

/** Resultado do migrador: indica se houve QUALQUER importacao confirmada. */
export interface MigracaoResult {
  migrou: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isBanda(v: unknown): v is BlocoBanda {
  return (
    v === "topo" ||
    v === "status" ||
    v === "ferramentas" ||
    v === "acao" ||
    v === "tabela"
  );
}

function isDensidade(v: unknown): v is Densidade {
  return v === "compacta" || v === "padrao" || v === "confortavel";
}

/** Le e parseia (JSON) uma chave do localStorage de forma tolerante a falhas. */
function safeReadJSON(key: string): unknown {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Le uma chave do localStorage como string crua (sem JSON.parse). */
function safeReadString(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Remove uma chave do localStorage sem lancar (EC-07 / D-DB-05). */
function safeRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* cache de UI: falha de remocao e inofensiva */
  }
}

/** Extrai preferencias escalares de `dlh.cfg` para um patch de dominio. */
function lerCfgPrefs(o: Record<string, unknown>): Partial<Configuracao> {
  const patch: Partial<Configuracao> = {};

  if (isDensidade(o.densidade)) patch.densidade = o.densidade;

  const rm = o.reduzirMovimento ?? o.reduzir_movimento;
  if (typeof rm === "boolean") patch.reduzirMovimento = rm;

  const hp = o.highlightPendencias ?? o.highlight_pendencias;
  if (typeof hp === "boolean") patch.highlightPendencias = hp;

  const tema = o.tema ?? o.temaNome;
  if (typeof tema === "string") {
    const id = temaIdDeNome(tema);
    if (id) patch.temaId = id;
  }

  return patch;
}

/**
 * Converte um mapa/array de escopos legado em linhas `bloco_config` do tipo dado.
 * Aceita:
 *   - array de escopos (string[])                  -> ordem = indice
 *   - mapa escopo -> boolean (visivel)
 *   - mapa escopo -> { visivel?, ordem?, banda? }
 */
function lerEscopoMap(
  raw: unknown,
  userId: string,
  orgId: string,
  tipo: BlocoTipo,
): BlocoConfigInsert[] {
  const out: BlocoConfigInsert[] = [];

  if (Array.isArray(raw)) {
    raw.forEach((escopo, i) => {
      if (typeof escopo === "string" && escopo) {
        out.push({ user_id: userId, org_id: orgId, escopo, tipo, ordem: i });
      }
    });
    return out;
  }

  if (isRecord(raw)) {
    let i = 0;
    for (const [escopo, v] of Object.entries(raw)) {
      if (!escopo) continue;
      const row: BlocoConfigInsert = {
        user_id: userId,
        org_id: orgId,
        escopo,
        tipo,
        ordem: i,
      };
      if (typeof v === "boolean") {
        row.visivel = v;
      } else if (isRecord(v)) {
        if (typeof v.visivel === "boolean") row.visivel = v.visivel;
        if (typeof v.ordem === "number") row.ordem = v.ordem;
        if (isBanda(v.banda)) row.banda = v.banda;
      }
      out.push(row);
      i += 1;
    }
  }

  return out;
}

/** Extrai blocos por tela de `dlh.cfg` (campos `blocks`/`blockvis`). */
function lerCfgBlocos(
  o: Record<string, unknown>,
  userId: string,
  orgId: string,
): BlocoConfigInsert[] {
  const blocks = o.blocks ?? o.blockvis;
  if (blocks === undefined || blocks === null) return [];
  return lerEscopoMap(blocks, userId, orgId, "bloco");
}

/**
 * Importa o estado legado do localStorage para o Supabase UMA UNICA VEZ.
 *
 * Mapeamento (SPEC 2.4.3):
 *   - `dlh.cfg` (v:1)      -> configuracao (prefs) + bloco_config (tipo `bloco`)
 *   - `dlh.cockpitcards`   -> bloco_config (tipo `card`)
 *   - `dlh.cockpitwidgets` -> bloco_config (tipo `widget`)
 *   - `dlh-theme`          -> configuracao.tema_id
 *
 * Cada chave so e removida (`safeRemove`) APOS o upsert correspondente confirmar
 * (EC-07). Uma falha em um bloco e logada e nao remove a chave nem aborta os
 * demais blocos — a chave permanece para re-tentativa no proximo boot.
 */
export async function migrarLegado(
  userId: string,
  orgId: string,
  applyConfig: ConfigWriter,
  client: TypedClient = db(),
): Promise<MigracaoResult> {
  if (typeof window === "undefined") {
    return { migrou: false };
  }

  const cfgRaw = safeReadJSON("dlh.cfg");
  const cardsRaw = safeReadJSON("dlh.cockpitcards");
  const widgetsRaw = safeReadJSON("dlh.cockpitwidgets");
  const themeRaw = safeReadString("dlh-theme");

  const temPendencia =
    cfgRaw !== null ||
    cardsRaw !== null ||
    widgetsRaw !== null ||
    (themeRaw !== null && themeRaw !== "");

  if (!temPendencia) {
    return { migrou: false };
  }

  let migrou = false;

  // --- dlh.cfg: prefs (configuracao) + blocos por tela (bloco_config) --------
  if (cfgRaw !== null) {
    try {
      if (isRecord(cfgRaw)) {
        const prefs = lerCfgPrefs(cfgRaw);
        if (Object.keys(prefs).length > 0) await applyConfig(prefs);
        const blocos = lerCfgBlocos(cfgRaw, userId, orgId);
        if (blocos.length > 0) await upsertBlocoConfigRows(client, blocos);
      }
      safeRemove("dlh.cfg");
      migrou = true;
    } catch (err) {
      console.error("[migrarLegado] falha ao importar dlh.cfg:", err);
    }
  }

  // --- dlh.cockpitcards: cards (bloco_config tipo `card`) --------------------
  if (cardsRaw !== null) {
    try {
      const rows = lerEscopoMap(cardsRaw, userId, orgId, "card");
      if (rows.length > 0) await upsertBlocoConfigRows(client, rows);
      safeRemove("dlh.cockpitcards");
      migrou = true;
    } catch (err) {
      console.error("[migrarLegado] falha ao importar dlh.cockpitcards:", err);
    }
  }

  // --- dlh.cockpitwidgets: widgets (bloco_config tipo `widget`) --------------
  if (widgetsRaw !== null) {
    try {
      const rows = lerEscopoMap(widgetsRaw, userId, orgId, "widget");
      if (rows.length > 0) await upsertBlocoConfigRows(client, rows);
      safeRemove("dlh.cockpitwidgets");
      migrou = true;
    } catch (err) {
      console.error("[migrarLegado] falha ao importar dlh.cockpitwidgets:", err);
    }
  }

  // --- dlh-theme: tema ativo (configuracao.tema_id) --------------------------
  if (themeRaw !== null && themeRaw !== "") {
    try {
      const id = temaIdDeNome(themeRaw);
      if (id) await applyConfig({ temaId: id });
      safeRemove("dlh-theme");
      migrou = true;
    } catch (err) {
      console.error("[migrarLegado] falha ao importar dlh-theme:", err);
    }
  }

  return { migrou };
}
