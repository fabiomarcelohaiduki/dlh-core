// =====================================================================
// Tokens visuais do Design Lock (SPEC 4.4 — Cockpit LionClaw).
// Fonte canonica dos valores de marca. Espelham os CSS custom properties
// declarados em src/app/globals.css (camada de referencia "Design Lock").
//
// IMPORTANTE: o accent de RUNTIME aplicado em globals.css e uma calibracao
// fina do ambar de marca (light: #c47a16, dark: #ea9a3c) e NAO deve ser
// sobrescrito por estes valores brutos. Estes tokens documentam a paleta
// de marca (SPEC 4.4.1) e alimentam o catalogo de temas (SPEC 4.4.5).
// =====================================================================

/** Cores de marca da SPEC 4.4.1 (tema LionClaw, padrao). */
export const colors = {
  bg: "#09090b",
  surface: "#18181b",
  border: "#27272a",
  /** Acento principal LionClaw. */
  accent: "#e27300",
  /** Acento profundo (hover/active). */
  accentDeep: "#b85c00",
  fg: "#fafafa",
  muted: "#a1a1aa",
  ok: "#4ade80",
  warn: "#facc15",
  danger: "#f87171",
} as const;

/** Tipografia base (SPEC 4.4.2). */
export const typography = {
  base: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif",
} as const;

/** Espacamento base 4px (SPEC 4.4.3). Escalavel por multiplos inteiros. */
export const spacing = {
  /** Unidade base em pixels. */
  base: 4,
  unit: "4px",
} as const;

/** Raio base 12px (SPEC 4.4.4). */
export const radii = {
  /** Raio base em pixels. */
  base: 12,
  unit: "12px",
} as const;

/** Identificadores dos 4 temas (SPEC 4.4.5). */
export type ThemeId = "lionclaw" | "claro" | "grafite" | "salvia";

/** Catalogo dos 4 temas: cada um declara 2-3 cores de marca (SPEC 4.4.5). */
export const themes: Record<
  ThemeId,
  { nome: string; acento: string; fundo: string; texto: string }
> = {
  lionclaw: { nome: "LionClaw", acento: "#e27300", fundo: "#09090b", texto: "#fafafa" },
  claro: { nome: "Claro", acento: "#e27300", fundo: "#fafafa", texto: "#09090b" },
  grafite: { nome: "Grafite", acento: "#e27300", fundo: "#27272a", texto: "#fafafa" },
  salvia: { nome: "Salvia", acento: "#7c9885", fundo: "#0f1411", texto: "#fafafa" },
};

/** Tema padrao do cockpit. */
export const DEFAULT_THEME: ThemeId = "lionclaw";

/** Agregado de todos os tokens do design. */
export const tokens = {
  colors,
  typography,
  spacing,
  radii,
  themes,
  defaultTheme: DEFAULT_THEME,
} as const;

export default tokens;
