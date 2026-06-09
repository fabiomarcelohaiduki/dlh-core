import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ExtracaoConfigForm } from "@/components/cockpit/extracao-config-form";
import type { ConfigExtracaoState, FonteExtracao } from "@/lib/api/types";

export const metadata: Metadata = { title: "Parâmetros de extração" };

const FONTES_EXTRACAO_VALIDAS: ReadonlySet<string> = new Set(["nomus", "effecti", "drive"]);

/** Linha lida de public.config_extracao (singleton de parametros da camada 1). */
interface ConfigExtracaoRow {
  ocr_estrategia: string | null;
  ocr_idioma: string | null;
  tamanho_max_bytes: number | null;
  timeout_ms: number | null;
  extensoes_habilitadas: string[] | null;
  fontes_habilitadas: string[] | null;
  lote_tamanho: number | null;
  pausa_lote_ms: number | null;
}

/**
 * Hidratacao server-side (RLS) dos parametros da camada 1 do extrator
 * (singleton config_extracao) para o cmp-extracao-config-form. Sem linha
 * (estado inicial improvavel — ha seed) cai nos defaults do produto.
 */
async function loadConfigExtracao(): Promise<ConfigExtracaoState> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("config_extracao")
    .select(
      "ocr_estrategia, ocr_idioma, tamanho_max_bytes, timeout_ms, extensoes_habilitadas, fontes_habilitadas, lote_tamanho, pausa_lote_ms",
    )
    .limit(1)
    .maybeSingle();

  const data = (raw ?? null) as ConfigExtracaoRow | null;
  const estrategia = data?.ocr_estrategia;
  const fontes = data?.fontes_habilitadas;

  return {
    ocrEstrategia:
      estrategia === "nunca" || estrategia === "sempre" ? estrategia : "auto",
    ocrIdioma: data?.ocr_idioma ?? "por+eng",
    tamanhoMaxBytes: data?.tamanho_max_bytes ?? 104857600,
    timeoutMs: data?.timeout_ms ?? 120000,
    extensoesHabilitadas: data?.extensoes_habilitadas ?? null,
    fontesHabilitadas:
      Array.isArray(fontes) && fontes.length > 0
        ? (fontes.filter((f) => FONTES_EXTRACAO_VALIDAS.has(f)) as FonteExtracao[])
        : null,
    loteTamanho: data?.lote_tamanho ?? 10,
    pausaLoteMs: data?.pausa_lote_ms ?? 0,
  };
}

export default async function ExtracaoConfigPage() {
  const configExtracao = await loadConfigExtracao();

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Parâmetros de extração</h2>
          <p>Configuração da camada 1 do extrator de anexos (texto puro, sem LLM).</p>
        </div>
      </div>

      <ExtracaoConfigForm initial={configExtracao} />
    </section>
  );
}
