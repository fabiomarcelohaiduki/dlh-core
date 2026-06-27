"use client";

import { useTema } from "@/hooks/use-tema";
import type { LionclawTheme } from "@/components/theme-provider";

type ThemeOption = {
  nome: LionclawTheme;
  titulo: string;
  descricao: string;
  swatches: string[];
};

/** Opcoes do seletor de tema da topbar (espelha o protótipo: titulo + copy
 *  curta + swatch-row). A persistencia/UUID fica em useTema. */
const TOPBAR_THEMES: ReadonlyArray<ThemeOption> = [
  {
    nome: "lionclaw",
    titulo: "LionClaw",
    descricao: "Oficial · carvão e laranja.",
    swatches: ["#f59e0b", "#d97706", "#09090b", "#18181b", "#fafafa"],
  },
  {
    nome: "claro",
    titulo: "Claro",
    descricao: "Areia clara com laranja.",
    swatches: ["oklch(60% 0.16 50)", "oklch(97% 0.008 75)", "oklch(22% 0.012 60)"],
  },
  {
    nome: "grafite",
    titulo: "Grafite",
    descricao: "Grafite frio e azul aço.",
    swatches: ["oklch(68% 0.11 235)", "oklch(15% 0.012 250)", "oklch(93% 0.006 250)"],
  },
  {
    nome: "salvia",
    titulo: "Sálvia",
    descricao: "Branco quente e verde sálvia.",
    swatches: ["oklch(56% 0.075 150)", "oklch(96% 0.012 130)", "oklch(24% 0.014 150)"],
  },
];

/**
 * cmp-topbar-theme-menu — menu do seletor de tema da topbar.
 *
 * Island carregado via `next/dynamic` com `ssr: false` (ver topbar.tsx): o
 * useTema embute o `useTheme` do next-themes, e rodar esse hook durante o
 * prerender estatico das paginas do cockpit quebrava a geracao (dispatcher de
 * hooks nulo no SSG). Mantendo o menu client-only o tema continua global na
 * topbar sem custo no build.
 *
 * `onSelect` fecha o submenu apos a escolha (estado de abertura fica na topbar,
 * que gerencia clique-fora/Escape no cluster).
 */
export function TopbarThemeMenu({ onSelect }: { onSelect: () => void }) {
  const { nome: temaAtivo, selecionarTema } = useTema();

  return (
    <div className="action-menu action-menu-theme" role="menu">
      {TOPBAR_THEMES.map((t) => (
        <button
          key={t.nome}
          type="button"
          className="theme-option"
          role="menuitemradio"
          aria-checked={temaAtivo === t.nome}
          data-active={temaAtivo === t.nome}
          onClick={() => {
            selecionarTema(t.nome);
            onSelect();
          }}
        >
          <span>
            <strong>{t.titulo}</strong>
            <small>{t.descricao}</small>
          </span>
          <span className="swatch-row" aria-hidden="true">
            {t.swatches.map((c, i) => (
              <i key={i} style={{ background: c }} />
            ))}
          </span>
        </button>
      ))}
    </div>
  );
}
