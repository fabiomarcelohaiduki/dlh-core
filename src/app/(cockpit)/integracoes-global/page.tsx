import type { Metadata } from "next";
import { loadConexoesFontes } from "@/lib/conexoes-fontes";
import { IntegracoesPainel } from "@/components/cockpit/integracoes-painel";

export const metadata: Metadata = { title: "Integrações" };

/**
 * View integracoes-global (/integracoes-global).
 *
 * Estado READ-ONLY das integrações pré-existentes. O bloco de conectores
 * (Nomus, Effecti, Drive, Gmail) lê o estado REAL de conexão hidratado no
 * servidor via loadConexoesFontes (mesma fonte do indicador do Topbar). O bloco
 * Plataforma descreve os serviços internos de auth e acervo. Acessível pelo
 * globalSettingsButton da Topbar.
 */
export default async function IntegracoesGlobalPage() {
  const conexoes = await loadConexoesFontes();

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Integrações</h2>
          <p>Conectores usados pela autenticação e ingestão operacional.</p>
        </div>
      </div>

      <div className="global-view">
        <IntegracoesPainel conexoes={conexoes} />

        <section className="cfg-panel-card" aria-labelledby="integracoes-plataforma-h">
          <div className="panel-header">
            <div className="panel-title">
              <h3 id="integracoes-plataforma-h">Plataforma</h3>
              <p>Serviços internos que sustentam a autenticação e o acervo.</p>
            </div>
            <span className="pill ok">Normal</span>
          </div>
          <ul className="stack-list">
            <li className="stack-item">
              <div className="stack-copy">
                <strong>Supabase Auth</strong>
                <span>Entrada com Google ativa para sessão protegida.</span>
              </div>
              <span className="pill ok">Ativo</span>
            </li>
            <li className="stack-item">
              <div className="stack-copy">
                <strong>Acervo de documentos</strong>
                <span>Destino de metadados e textos processados.</span>
              </div>
              <span className="pill ok">Normal</span>
            </li>
          </ul>
        </section>
      </div>
    </section>
  );
}
