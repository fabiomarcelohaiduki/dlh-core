import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ExtracaoPanel } from "@/components/cockpit/extracao-panel";

export const metadata: Metadata = { title: "Extração" };

/** Linha lida de public.fontes (apenas a presenca da referencia, nunca o segredo). */
interface FonteRow {
  token_cifrado: string | null;
}

/**
 * Hidratacao server-side (RLS) do estado da credencial Nomus. Deriva apenas
 * `configurado` (token_cifrado != null) para bloquear/liberar a descoberta;
 * o segredo jamais trafega ao cliente (RNF-02).
 */
async function loadNomusConfigurado(): Promise<boolean> {
  const supabase = await createClient();
  const { data: raw } = await supabase
    .from("fontes")
    .select("token_cifrado")
    .eq("tipo", "nomus")
    .maybeSingle();
  const data = (raw ?? null) as FonteRow | null;
  return Boolean(data?.token_cifrado);
}

export default async function ExtracaoPage() {
  const nomusConfigurado = await loadNomusConfigurado();

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Extração de anexos</h2>
          <p>
            Monitoramento da camada 1 do pipeline de documentos. Enfileire os anexos pendentes e
            acompanhe o que foi extraído, herdado ou falhou. Os parâmetros ficam em Parâmetros de
            extração, na Administração.
          </p>
        </div>
      </div>

      <ExtracaoPanel nomusConfigurado={nomusConfigurado} />
    </section>
  );
}
