// =====================================================================
// Camada de dados (db/) — catalogo de temas (tabela `tema`, SPEC 2.1.1 / 2.4.1).
//
// Persistencia canonica via Supabase client direto com RLS (D-BE-01). NAO ha
// endpoint REST/Route Handler. A leitura e global para usuarios autenticados
// (policy `tema_select_authenticated`); o catalogo e estatico (4 temas seed).
//
// A traducao UUID <-> nome (next-themes) e estavel e ja vive em `@/lib/api/tema`;
// re-exportamos os helpers puros aqui para que a camada db/ seja coesa e o
// migrador (cfg.ts) os consuma sem cruzar camadas.
// =====================================================================

import { db, type TypedClient } from "@/lib/api/session";
import { TEMA_IDS, nomeDeTemaId, temaIdDeNome } from "@/lib/api/tema";
import type { TemaRow } from "@/types/database";
import type { Tema } from "@/types/domain";

export { TEMA_IDS, nomeDeTemaId, temaIdDeNome };

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

/**
 * SELECT dos temas do catalogo global (os 4 temas seed da SPEC 2.4.1).
 * Ordenado por `created_at` para preservar a ordem de seed. A RLS libera a
 * leitura a qualquer usuario autenticado.
 */
export async function listarTemas(client: TypedClient = db()): Promise<Tema[]> {
  const { data, error } = await client
    .from("tema")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Falha ao carregar temas: ${error.message}`);
  return (data ?? []).map(rowToTema);
}
