/// <reference lib="deno.ns" />
// =====================================================================
// scripts/backfill-avisos-embeddings.ts
// Backfill one-shot: reindexa os avisos com status_indexacao='pendente'
// (furo silencioso de 2026-06-18, quando a ESCRITA de avisos ainda dependia
// do provider legado bge-m3 via EMBEDDINGS_ENDPOINT; o secret saiu e a
// indexacao inline foi pulada em silencio, deixando 445 avisos sem chunks).
//
// Reusa o MOTOR REAL das Edges (createServiceClient + resolveEmbeddingProvider
// + generateAndStoreChunks) via service_role -- nao precisa de JWT de sessao
// humana (substrato-reindexar exige getUser, que a Lia nao consegue cunhar).
// Os chunks gerados ficam identicos aos do pipeline (mesmo OpenAI/Vault,
// mesmo chunker), sem mistura de modelos.
//
// NAO seta 'em_andamento' intermediario: em caso de interrupcao o aviso
// permanece 'pendente' e e re-coletado na proxima rodada (recall-safe).
//
// Uso:
//   deno run --allow-env --allow-net --env-file=.env.local \
//     --import-map supabase/functions/deno.json \
//     scripts/backfill-avisos-embeddings.ts [--limit N]
//
//   --limit N : processa no maximo N avisos (use --limit 1 para o teste).
//   sem flag  : processa todos os pendentes.
// =====================================================================

import { createServiceClient } from "../supabase/functions/_shared/supabase.ts";
import { resolveEmbeddingProvider } from "../supabase/functions/_shared/indexacao.ts";
import { generateAndStoreChunks } from "../supabase/functions/_shared/embeddings.ts";

function parseLimit(): number | null {
  const idx = Deno.args.indexOf("--limit");
  if (idx === -1) return null;
  const raw = Deno.args[idx + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit invalido: ${raw}`);
  }
  return n;
}

interface AvisoPend {
  id: string;
  conteudo_verbatim: string | null;
}

async function main(): Promise<void> {
  const limit = parseLimit();
  const db = createServiceClient();
  const provider = await resolveEmbeddingProvider();

  const pageSize = 200;
  let processados = 0;
  let falhas = 0;
  let pulados = 0;

  for (;;) {
    if (limit !== null && processados >= limit) break;
    const restante = limit !== null ? limit - processados : pageSize;
    const lote = Math.min(restante, pageSize);

    // 'indexado'/'erro' tiram o aviso do conjunto 'pendente' a cada iteracao,
    // entao a paginacao avanca naturalmente sem offset.
    const { data, error } = await db
      .from("avisos")
      .select("id, conteudo_verbatim")
      .eq("status_indexacao", "pendente")
      .limit(lote);
    if (error) throw new Error(`falha ao listar pendentes: ${error.message}`);

    const pendentes = (data ?? []) as AvisoPend[];
    if (pendentes.length === 0) break;

    for (const aviso of pendentes) {
      if (limit !== null && processados >= limit) break;
      const verbatim = (aviso.conteudo_verbatim ?? "").trim();
      if (verbatim === "") {
        pulados += 1;
        console.warn(`[backfill] aviso ${aviso.id} sem verbatim -> pulado`);
        continue;
      }
      try {
        const res = await generateAndStoreChunks(db, {
          avisoId: aviso.id,
          verbatim,
          provider,
        });
        await db.from("avisos").update({ status_indexacao: "indexado" }).eq("id", aviso.id);
        processados += 1;
        console.log(`[backfill] ${processados} OK aviso ${aviso.id} chunks=${res.chunks}`);
      } catch (err) {
        falhas += 1;
        await db.from("avisos").update({ status_indexacao: "erro" }).eq("id", aviso.id);
        console.error(
          `[backfill] ERRO aviso ${aviso.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  console.log(`[backfill] fim: ${processados} indexados, ${falhas} erros, ${pulados} pulados.`);
}

await main();
