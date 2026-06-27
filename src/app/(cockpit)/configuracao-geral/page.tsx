import type { Metadata } from "next";
import { EnvSettingsForm } from "@/components/cockpit/config/env-settings-form";

export const metadata: Metadata = { title: "Configuração geral" };

/**
 * View configuracao-global (/configuracao-geral).
 *
 * Preferências de todo o ambiente: 7 paineis reais (sem fachada), theme-picker
 * dos 4 temas e controles cc-*. Persistência ao vivo (sem botão Salvar) com
 * toast de confirmação. O conteúdo é client-side (hooks de configuração/tema);
 * esta página é apenas a casca server + metadata.
 */
export default function ConfiguracaoGeralPage() {
  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Configuração geral</h2>
          <p>
            Preferências de todo o ambiente. Os blocos por tela ficam dentro das
            configurações de cada módulo.
          </p>
        </div>
      </div>

      <EnvSettingsForm />
    </section>
  );
}
