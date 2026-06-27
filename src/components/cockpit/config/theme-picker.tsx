"use client";

import { useEffect, useState } from "react";
import { useTema } from "@/hooks/use-tema";
import { LIONCLAW_THEMES, type LionclawTheme } from "@/components/theme-provider";
import { colors } from "@/lib/tokens";

/** Swatch nomeado exibido nos cards e na paleta do tema ativo. */
interface Swatch {
  cor: string;
  rotulo: string;
}

/** Metadado visual dos 4 temas (Design Lock). Os UUIDs/persistência ficam em use-tema. */
interface ThemeMeta {
  nome: LionclawTheme;
  titulo: string;
  tag: string;
  descricao: string;
  swatches: Swatch[];
}

const THEMES: ReadonlyArray<ThemeMeta> = [
  {
    nome: "lionclaw",
    titulo: "LionClaw",
    tag: "Oficial",
    descricao: "Carvão quente e laranja LionClaw. Base operacional padrão.",
    swatches: [
      { cor: colors.accent, rotulo: "Acento" },
      { cor: colors.accentDeep, rotulo: "Acento profundo" },
      { cor: colors.bg, rotulo: "Fundo" },
      { cor: colors.surface, rotulo: "Superfície" },
      { cor: colors.fg, rotulo: "Texto" },
    ],
  },
  {
    nome: "claro",
    titulo: "Claro",
    tag: "Light",
    descricao: "Areia clara mantendo o laranja da marca para ambientes iluminados.",
    swatches: [
      { cor: "oklch(60% 0.16 50)", rotulo: "Acento" },
      { cor: "oklch(97% 0.008 75)", rotulo: "Fundo" },
      { cor: "oklch(22% 0.012 60)", rotulo: "Texto" },
    ],
  },
  {
    nome: "grafite",
    titulo: "Grafite",
    tag: "Dark",
    descricao: "Grafite frio com acento azul aço dessaturado.",
    swatches: [
      { cor: "oklch(68% 0.11 235)", rotulo: "Acento" },
      { cor: "oklch(15% 0.012 250)", rotulo: "Fundo" },
      { cor: "oklch(93% 0.006 250)", rotulo: "Texto" },
    ],
  },
  {
    nome: "salvia",
    titulo: "Sálvia",
    tag: "Light",
    descricao: "Branco quente com acento verde sálvia, leitura suave.",
    swatches: [
      { cor: "oklch(56% 0.075 150)", rotulo: "Acento" },
      { cor: "oklch(96% 0.012 130)", rotulo: "Fundo" },
      { cor: "oklch(24% 0.014 150)", rotulo: "Texto" },
    ],
  },
];

/**
 * theme-picker — seletor visual dos 4 temas LionClaw no painel Aparência.
 *
 * Selecionar um card chama `selecionarTema`, que aplica o tema imediatamente via
 * next-themes (refletindo também na tela /login, espelhada) E persiste
 * `configuracao.tema_id` ao vivo (PATCH). O card ativo é destacado por
 * `data-active`. A paleta lateral mostra as cores do tema ativo.
 *
 * `onAplicado` é chamado em cada seleção para o formulário disparar o toast.
 * `onErro` (EC-19) é chamado quando a persistência do tema falha — o tema visual
 * já foi revertido pelo `selecionarTema`; aqui o formulário sinaliza o erro.
 */
export function ThemePicker({
  onAplicado,
  onErro,
}: {
  onAplicado?: () => void;
  onErro?: () => void;
}) {
  const { nome, selecionarTema } = useTema();

  // Evita mismatch SSR: antes da hidratação assume o tema padrão estável.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const ativo: LionclawTheme =
    mounted && LIONCLAW_THEMES.includes(nome) ? nome : "lionclaw";

  const temaAtivo = THEMES.find((t) => t.nome === ativo) ?? THEMES[0];

  function aplicar(t: LionclawTheme) {
    if (t === ativo) return;
    selecionarTema(t, { onError: onErro });
    onAplicado?.();
  }

  return (
    <div className="appearance-grid">
      <div className="theme-picker" id="configThemePicker">
        {THEMES.map((t) => {
          const isActive = t.nome === ativo;
          return (
            <button
              key={t.nome}
              type="button"
              className="theme-card"
              data-active={isActive}
              aria-pressed={isActive}
              aria-label={`Aplicar tema ${t.titulo}`}
              onClick={() => aplicar(t.nome)}
            >
              <span className="swatch-row" aria-hidden="true">
                {t.swatches.map((s, i) => (
                  <i key={i} style={{ background: s.cor }} />
                ))}
              </span>
              <span className="theme-card-name">
                <strong>{t.titulo}</strong>
                <span>{t.tag}</span>
              </span>
              <p>{t.descricao}</p>
            </button>
          );
        })}
      </div>

      <aside id="themePalette" className="palette-card" aria-label="Cores do tema ativo">
        <span className="palette-label">Cores do tema ativo</span>
        <div className="palette-grid">
          {temaAtivo.swatches.map((s, i) => (
            <div key={i} className="swatch-chip">
              <span className="swatch-dot" style={{ background: s.cor }} aria-hidden="true" />
              <span className="swatch-copy">
                <strong>{s.rotulo}</strong>
                <span className="code">{s.cor}</span>
              </span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

/** Rótulo "Titulo · Tag" do tema ativo, para o pill do cabeçalho do painel. */
export function useTemaAtivoLabel(): string {
  const { nome } = useTema();
  const meta = THEMES.find((t) => t.nome === nome) ?? THEMES[0];
  return `${meta.titulo} · ${meta.tag}`;
}
