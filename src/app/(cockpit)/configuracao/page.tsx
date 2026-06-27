import type { Metadata } from "next";
import { CockpitSettingsForm } from "@/components/cockpit/config/cockpit-settings-form";

export const metadata: Metadata = { title: "Configuração do cockpit" };

/**
 * View configuracao (/configuracao) — Configuração do cockpit (delta-16/17).
 *
 * Controla visibilidade e ordem dos cards de módulo e dos painéis fixos do
 * cockpit via `bloco_config` (tipo card/widget). Persistência ao vivo (sem
 * botão Salvar). O conteúdo é client-side (hooks de bloco_config); esta página
 * é apenas a casca server + metadata.
 */
export default function ConfiguracaoCockpitPage() {
  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Configuração do cockpit</h2>
          <p>
            Escolha quais cards de módulo e painéis fixos aparecem na visão geral
            e em que ordem. Os blocos por tela ficam nas configurações de cada
            módulo.
          </p>
        </div>
      </div>

      <CockpitSettingsForm />
    </section>
  );
}
