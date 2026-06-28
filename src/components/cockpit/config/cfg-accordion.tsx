"use client";

// =====================================================================
// cfg-accordion — acordeao dos blocos de configuracao (espelha o prototipo
// "Refatoracao de Design e Layout"). Cada bloco filho direto vira um item:
// clicar no cabecalho abre/fecha, um aberto por vez, o primeiro abre por padrao.
//
// DOM-driven de proposito: opera sobre os blocos JA renderizados (cfg-panel-card
// ou os cards de formulario com .section-title), entao funciona com blocos vindos
// do servidor ou do cliente sem exigir que cada painel seja reescrito. O cabecalho
// de cada bloco e o seu `.panel-header` (ou `.section-title` nos cards de
// formulario). Blocos sem cabecalho ficam sempre abertos (ex.: um toast solto que
// vaze para dentro do acordeao). O estado visual (aberto/fechado) vive no atributo
// `data-collapsed` de cada bloco; o CSS em globals.css cuida do chevron e do colapso.
// =====================================================================

import { useEffect, useRef } from "react";

/** Cabecalho clicavel de um bloco: painel de config ou card de formulario. */
const HEADER_SELECTOR = ":scope > .panel-header, :scope > .section-title";

export function CfgAccordion({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const headerOf = (panel: Element) =>
      panel.querySelector<HTMLElement>(HEADER_SELECTOR);

    const panels = () => Array.from(root.children) as HTMLElement[];

    // Garante atributos de acessibilidade e o estado inicial (primeiro bloco com
    // cabecalho aberto). Idempotente: nao mexe em blocos que ja tem estado, para
    // preservar o que o usuario abriu quando o React re-renderiza um corpo.
    function ensure() {
      const jaTemAberto = panels().some(
        (p) => headerOf(p) && p.dataset.collapsed === "false",
      );
      let primeiro = true;
      for (const panel of panels()) {
        const header = headerOf(panel);
        if (!header) continue;
        header.setAttribute("role", "button");
        header.setAttribute("tabindex", "0");
        if (panel.dataset.collapsed === undefined) {
          panel.dataset.collapsed = !jaTemAberto && primeiro ? "false" : "true";
        }
        primeiro = false;
      }
    }

    function toggle(alvo: HTMLElement) {
      const abrir = alvo.dataset.collapsed === "true";
      for (const panel of panels()) {
        if (headerOf(panel)) panel.dataset.collapsed = "true";
      }
      alvo.dataset.collapsed = abrir ? "false" : "true";
    }

    // Resolve o bloco a partir de um clique/tecla: o cabecalho tem de ser filho
    // direto de um bloco que, por sua vez, e filho direto do acordeao (ignora
    // cabecalhos aninhados no corpo de um bloco, ex.: as fontes em Integracoes).
    function panelFromEvent(target: EventTarget | null): HTMLElement | null {
      if (!(target instanceof Element)) return null;
      const header = target.closest<HTMLElement>(".panel-header, .section-title");
      if (!header) return null;
      const panel = header.parentElement;
      if (!panel || panel.parentElement !== root) return null;
      return panel as HTMLElement;
    }

    function onClick(e: MouseEvent) {
      const panel = panelFromEvent(e.target);
      if (panel) toggle(panel);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" && e.key !== " ") return;
      const panel = panelFromEvent(e.target);
      if (!panel) return;
      e.preventDefault();
      toggle(panel);
    }

    ensure();
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);
    const obs = new MutationObserver(() => ensure());
    obs.observe(root, { childList: true });

    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
      obs.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className="cfg-accordion">
      {children}
    </div>
  );
}
