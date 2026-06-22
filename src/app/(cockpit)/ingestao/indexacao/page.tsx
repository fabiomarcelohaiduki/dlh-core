import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { IndexacaoConfigForm } from "@/components/cockpit/indexacao-config-form";
import { IndexacaoDisparoForm } from "@/components/cockpit/indexacao-disparo-form";
import { IndexacaoAvisosResumo } from "@/components/cockpit/indexacao-avisos-resumo";
import type { ConfigIndexacaoState, FonteIndexacao } from "@/lib/api/types";

export const metadata: Metadata = { title: "Indexação" };

const FONTES_INDEXACAO_VALIDAS: ReadonlySet<string> = new Set([
  "nomus",
  "effecti",
  "drive",
  "gmail",
]);

/** Linha lida de public.config_indexacao (singleton da camada de embeddings). */
interface ConfigIndexacaoRow {
  ativo: boolean | null;
  processos_ativo: boolean | null;
  fontes_habilitadas: string[] | null;
  lote_chunks: number | null;
  pausa_ms: number | null;
  tpm_alvo: number | null;
  tentativas_max: number | null;
  embeddings_provider: string | null;
  embeddings_endpoint: string | null;
}

/**
 * Hidratacao server-side (RLS) da config da indexacao (singleton
 * config_indexacao) para o cmp-indexacao-config-form. Sem linha (improvavel —
 * ha seed) cai nos defaults do produto (desligado, todas as fontes, 1500/0).
 */
async function loadConfigIndexacao(): Promise<ConfigIndexacaoState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("config_indexacao")
    .select("ativo, processos_ativo, fontes_habilitadas, lote_chunks, pausa_ms, tpm_alvo, tentativas_max, embeddings_provider, embeddings_endpoint")
    .limit(1)
    .maybeSingle();

  const data = (raw ?? null) as ConfigIndexacaoRow | null;
  const fontes = data?.fontes_habilitadas;

  return {
    ativo: data?.ativo ?? false,
    processosAtivo: data?.processos_ativo ?? false,
    fontesHabilitadas:
      Array.isArray(fontes) && fontes.length > 0
        ? (fontes.filter((f) => FONTES_INDEXACAO_VALIDAS.has(f)) as FonteIndexacao[])
        : null,
    loteChunks: data?.lote_chunks ?? 1500,
    pausaMs: data?.pausa_ms ?? 0,
    tpmAlvo: data?.tpm_alvo ?? 800000,
    tentativasMax: data?.tentativas_max ?? 3,
    embeddingsProvider: data?.embeddings_provider === "bge-m3-local" ? "bge-m3-local" : "openai",
    embeddingsEndpoint:
      typeof data?.embeddings_endpoint === "string" && data.embeddings_endpoint.trim() !== ""
        ? data.embeddings_endpoint.trim()
        : null,
  };
}

export default async function IngestaoIndexacaoPage() {
  const config = await loadConfigIndexacao();

  return (
    <>
      <div className="extracao-acoes-row">
        <IndexacaoDisparoForm fontes={config.fontesHabilitadas} ativo={config.ativo} />
        <IndexacaoAvisosResumo />
      </div>

      <IndexacaoConfigForm initial={config} />
    </>
  );
}
