import type { Metadata } from "next";
import { loadConexoesFontes } from "@/lib/conexoes-fontes";
import { loadFontesCredenciais } from "@/lib/fontes-credenciais-data";
import { FontesCredenciais } from "@/components/cockpit/fontes-credenciais";
import { CfgAccordion } from "@/components/cockpit/config/cfg-accordion";
import { StatusPill } from "@/components/cockpit/status-pill";
import { ConfiguracoesIaForm } from "@/components/cockpit/configuracoes-ia-form";
import { ConfiguracoesRerankForm } from "@/components/cockpit/configuracoes-rerank-form";
import type { FonteConexao, PillState } from "@/lib/status";

export const metadata: Metadata = { title: "Integrações" };

/** Resumo do header dos conectores: erro vence; tudo ok = operacional; senão parcial. */
function resumoConexoes(conexoes: FonteConexao[]): { state: PillState; label: string } {
  if (conexoes.some((c) => c.state === "err")) {
    return { state: "err", label: "Verificar" };
  }
  if (conexoes.length > 0 && conexoes.every((c) => c.state === "ok")) {
    return { state: "ok", label: "Operacional" };
  }
  return { state: "idle", label: "Parcial" };
}

/**
 * View integracoes-global (/integracoes-global).
 *
 * Hub das integrações externas que servem o projeto todo. O bloco de conectores
 * (Effecti, Nomus, Drive, Gmail) traz o painel EDITÁVEL das fontes —
 * só as credenciais e conexão de cada uma (FontesCredenciais) — embutido no
 * layout de cards de configuração. Os filtros de coleta (janela, pastas,
 * labels, recursos) e o disparo manual migraram para a guia Escopo do submódulo
 * Coleta; a cadência da coleta automática (agendamento) saiu para a guia
 * Agendamento da Coleta. O resumo do cabeçalho usa o estado REAL
 * de conexão hidratado no servidor (loadConexoesFontes, mesma fonte do
 * indicador do Topbar). Os cards de provedores externos (IA OpenAI; Cohere para
 * reranking) trazem provedor, chave e parâmetros editáveis. O bloco Plataforma
 * descreve os serviços internos de auth e acervo. Acessível pelo
 * globalSettingsButton da Topbar.
 */
export default async function IntegracoesGlobalPage() {
  const [conexoes, fontes] = await Promise.all([
    loadConexoesFontes(),
    loadFontesCredenciais(),
  ]);
  const resumo = resumoConexoes(conexoes);

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Integrações</h2>
          <p>Conectores, autenticações e provedores externos usados em todo o cockpit.</p>
        </div>
      </div>

      <div className="global-view">
        <CfgAccordion>
        <section className="cfg-panel-card" aria-labelledby="integracoes-conectores-h">
          <div className="panel-header">
            <div className="panel-title">
              <h3 id="integracoes-conectores-h">Conectores de ingestão</h3>
              <p>Credenciais e conexão de cada fonte de ingestão. Os filtros de coleta ficam na guia Escopo e o agendamento na guia Agendamento, ambas no submódulo Coleta.</p>
            </div>
            <StatusPill state={resumo.state} label={resumo.label} />
          </div>
          <div className="cfg-panel-body">
            <FontesCredenciais {...fontes} />
          </div>
        </section>

        <ConfiguracoesIaForm />

        <ConfiguracoesRerankForm />

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
        </CfgAccordion>
      </div>
    </section>
  );
}
