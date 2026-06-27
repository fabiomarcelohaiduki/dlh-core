// =====================================================================
// cfg.ts — raiz de configuracao versionada (cfgRoot v=1) + migrador de
// leitura unica localStorage -> Supabase (SPEC 2.4.3 / delta-19 / D-DB-05).
//
// Principio (notas de arquitetura): Supabase e a FONTE DA VERDADE; o
// localStorage e apenas cache de UI (tema, densidade, sidebar-recolhida,
// reduzir-movimento, highlight-pendencias). No primeiro acesso autenticado,
// o estado legado guardado no localStorage e importado UMA UNICA VEZ para o
// Supabase e as chaves legadas sao descartadas com `safeRemove`. Como as
// chaves sao removidas ao final, execucoes subsequentes nao reimportam nada
// (idempotencia natural).
// =====================================================================

import { upsertBlocoConfigRows } from "@/lib/api/bloco-config";
import { temaIdDeNome } from "@/lib/api/tema";
import type { TypedClient, UserOrg } from "@/lib/api/session";
import type {
  BlocoBanda,
  BlocoConfigInsert,
  BlocoTipo,
  ConfiguracaoUpdate,
  Densidade,
} from "@/types/database";

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

/** Resultado do migrador: se houve migracao e o patch de configuracao a aplicar. */
export interface MigracaoResult {
  migrou: boolean;
  configPatch: ConfiguracaoUpdate | null;
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

/** Remove uma chave do localStorage sem lancar (SPEC 5.1.4 / D-DB-05). */
function safeRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* cache de UI: falha de remocao e inofensiva */
  }
}

/** Extrai preferencias escalares de `dlh.cfg` para um patch de configuracao. */
function lerCfgPrefs(o: Record<string, unknown>): ConfiguracaoUpdate {
  const patch: ConfiguracaoUpdate = {};

  if (isDensidade(o.densidade)) patch.densidade = o.densidade;

  const rm = o.reduzirMovimento ?? o.reduzir_movimento;
  if (typeof rm === "boolean") patch.reduzir_movimento = rm;

  const hp = o.highlightPendencias ?? o.highlight_pendencias;
  if (typeof hp === "boolean") patch.highlight_pendencias = hp;

  const tema = o.tema ?? o.temaNome;
  if (typeof tema === "string") {
    const id = temaIdDeNome(tema);
    if (id) patch.tema_id = id;
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
  ctx: UserOrg,
  tipo: BlocoTipo,
): BlocoConfigInsert[] {
  const out: BlocoConfigInsert[] = [];

  if (Array.isArray(raw)) {
    raw.forEach((escopo, i) => {
      if (typeof escopo === "string" && escopo) {
        out.push({
          user_id: ctx.userId,
          org_id: ctx.orgId,
          escopo,
          tipo,
          ordem: i,
        });
      }
    });
    return out;
  }

  if (isRecord(raw)) {
    let i = 0;
    for (const [escopo, v] of Object.entries(raw)) {
      if (!escopo) continue;
      const row: BlocoConfigInsert = {
        user_id: ctx.userId,
        org_id: ctx.orgId,
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
function lerCfgBlocos(o: Record<string, unknown>, ctx: UserOrg): BlocoConfigInsert[] {
  const blocks = o.blocks ?? o.blockvis;
  if (blocks === undefined || blocks === null) return [];
  return lerEscopoMap(blocks, ctx, "bloco");
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
 * Ao final, descarta as chaves legadas com `safeRemove`. Retorna o patch de
 * configuracao para o chamador aplicar (evita acoplamento circular com a API
 * de configuracao).
 */
export async function migrarLegado(
  client: TypedClient,
  ctx: UserOrg,
): Promise<MigracaoResult> {
  if (typeof window === "undefined") {
    return { migrou: false, configPatch: null };
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
    return { migrou: false, configPatch: null };
  }

  const configPatch: ConfiguracaoUpdate = {};
  const inserts: BlocoConfigInsert[] = [];

  if (isRecord(cfgRaw)) {
    Object.assign(configPatch, lerCfgPrefs(cfgRaw));
    inserts.push(...lerCfgBlocos(cfgRaw, ctx));
  }

  inserts.push(...lerEscopoMap(cardsRaw, ctx, "card"));
  inserts.push(...lerEscopoMap(widgetsRaw, ctx, "widget"));

  if (themeRaw) {
    const id = temaIdDeNome(themeRaw);
    if (id) configPatch.tema_id = id;
  }

  if (inserts.length > 0) {
    await upsertBlocoConfigRows(client, inserts);
  }

  // Descarta as chaves legadas: garante que a migracao roda uma unica vez.
  for (const key of LEGACY_KEYS) safeRemove(key);

  return {
    migrou: true,
    configPatch: Object.keys(configPatch).length > 0 ? configPatch : null,
  };
}
