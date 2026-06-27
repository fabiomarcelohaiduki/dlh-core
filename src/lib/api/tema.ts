// =====================================================================
// API layer — catalogo de temas (tabela `tema`, SPEC 2.1.1 / 2.4.1).
//
// Leitura global para usuarios autenticados (policy `select_authenticated`).
// O catalogo e estatico (4 temas seed) e mapeia 1:1 com os nomes do
// next-themes usados pelo ThemeProvider (`lionclaw`/`claro`/`grafite`/`salvia`).
// A configuracao do usuario referencia o tema por UUID (`configuracao.tema_id`);
// este modulo provê a traducao UUID <-> nome consumida por `use-tema`.
// =====================================================================

import { db } from "@/lib/api/session";
import type { TemaRow } from "@/types/database";
import type { Tema } from "@/types/domain";
import type { LionclawTheme } from "@/components/theme-provider";

/** Nome do tema padrao quando nao ha preferencia (espelha DEFAULT_THEME). */
const DEFAULT_NOME: LionclawTheme = "lionclaw";

/**
 * UUIDs fixos do seed (SPEC 2.4.1) mapeados ao nome next-themes.
 * `satisfies` garante cobertura exata dos 4 temas em tempo de compilacao.
 */
export const TEMA_IDS = {
  lionclaw: "00000000-0000-0000-0000-000000000001",
  claro: "00000000-0000-0000-0000-000000000002",
  grafite: "00000000-0000-0000-0000-000000000003",
  salvia: "00000000-0000-0000-0000-000000000004",
} as const satisfies Record<LionclawTheme, string>;

const ID_TO_NOME: Readonly<Record<string, LionclawTheme>> = Object.freeze(
  Object.fromEntries(
    Object.entries(TEMA_IDS).map(([nome, id]) => [id, nome as LionclawTheme]),
  ),
);

/** Traduz o `tema_id` (UUID) para o nome do tema next-themes. */
export function nomeDeTemaId(id: string | null | undefined): LionclawTheme {
  if (!id) return DEFAULT_NOME;
  return ID_TO_NOME[id] ?? DEFAULT_NOME;
}

/** Traduz o nome do tema next-themes para o `tema_id` (UUID), ou null se desconhecido. */
export function temaIdDeNome(nome: string | null | undefined): string | null {
  if (!nome) return null;
  return (TEMA_IDS as Record<string, string>)[nome] ?? null;
}

function rowToTema(r: TemaRow): Tema {
  return {
    id: r.id,
    nome: r.nome,
    acento: r.acento,
    fundo: r.fundo,
    texto: r.texto,
    createdAt: r.created_at,
  };
}

/** GET — catalogo completo de temas (leitura global autenticada). */
export async function getTemas(): Promise<Tema[]> {
  const client = db();
  const { data, error } = await client
    .from("tema")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Falha ao carregar temas: ${error.message}`);
  return (data ?? []).map(rowToTema);
}
