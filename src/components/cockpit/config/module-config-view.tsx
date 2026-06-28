import type { ReactNode } from "react";
import { MODULE_CONFIGS, type EstadoTom, type ModuloId } from "@/lib/cockpit-config";
import { BlockMatrix } from "./block-matrix";
import { CfgAccordion } from "./cfg-accordion";

/** Mapeia o tom do estado para a classe da pill (neutral usa a pill base). */
function tomClass(tom: EstadoTom): string {
  if (tom === "ok") return "pill ok";
  if (tom === "warn") return "pill warn";
  return "pill";
}

/**
 * module-config-view — view "Configurações do módulo" (delta-15/28).
 *
 * Compartilhada pela rota dinâmica `/[modulo]/configuracoes-do-modulo` e pelo
 * wrapper estático de Ingestão (que colide com a pasta estática `ingestao/`).
 * Renderiza dois painéis:
 *   - "Estado do módulo": read-only (apenas leitura) com pills de tom.
 *   - "Blocos por tela": block-matrix filtrado pelo módulo, persistência ao vivo.
 *
 * `children` é um slot opcional para ações específicas do módulo (ex.: Cadastros
 * passa o card "Reindexar busca de produtos"), renderizado dentro da mesma
 * `screen` após os blocos. Módulos sem ação extra não passam nada.
 */
export function ModuleConfigView({
  modulo,
  children,
}: {
  modulo: ModuloId;
  children?: ReactNode;
}) {
  const cfg = MODULE_CONFIGS[modulo];

  return (
    <section className="screen">
      <div className="page-head">
        <div className="titles">
          <h2>Configurações do módulo · {cfg.label}</h2>
          <p>
            Estado operacional do módulo e organização dos blocos de cada tela.
          </p>
        </div>
      </div>

      <CfgAccordion>
      {/* Estado do módulo (read-only) */}
      <section className="cfg-panel-card estado-modulo" aria-labelledby="estado-modulo-h">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="estado-modulo-h">Estado do módulo · {cfg.label}</h3>
            <p>Como o módulo está configurado hoje. Definido pela operação.</p>
          </div>
          <span className="pill">Apenas leitura</span>
        </div>
        <ul className="stack-list">
          {cfg.estado.map((item) => (
            <li key={item.label} className="stack-item">
              <div className="stack-copy">
                <strong>{item.label}</strong>
                <span>{item.desc}</span>
              </div>
              <span className={tomClass(item.tom)}>{item.valor}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Blocos por tela (block-matrix filtrado pelo módulo) */}
      <section className="cfg-panel-card" aria-labelledby="blocos-tela-h">
        <div className="panel-header">
          <div className="panel-title">
            <h3 id="blocos-tela-h">Blocos por tela</h3>
            <p>
              Mostre ou oculte, reordene e reposicione os blocos de cada tela do
              módulo. As mudanças valem só para você.
            </p>
          </div>
        </div>
        <BlockMatrix modulo={modulo} />
      </section>

      {children}
      </CfgAccordion>
    </section>
  );
}
