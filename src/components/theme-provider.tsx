"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps } from "next-themes";
import type { ReactNode } from "react";

/** Os 4 temas LionClaw (SPEC 4.4.5 / tokens da Sprint 2). */
export const LIONCLAW_THEMES = ["lionclaw", "claro", "grafite", "salvia"] as const;
export type LionclawTheme = (typeof LIONCLAW_THEMES)[number];

/** Tema padrao aplicado quando nao ha preferencia salva. */
export const DEFAULT_THEME: LionclawTheme = "lionclaw";

/**
 * ThemeProvider
 *
 * Wrapper client-side sobre `next-themes`. Aplica o tema ativo no `<html>` via
 * `data-theme` (estado `theme-applied`); cada valor casa com um bloco
 * `:root[data-theme="..."]` em globals.css cujas cores derivam das cores de
 * marca por `color-mix()` (SPEC 4.4.5). Default = LionClaw.
 *
 * Os 4 temas sao definidos (sem `system`), com persistencia em localStorage na
 * chave `lionclaw-theme`. O script anti-FOUC injetado por next-themes e o UNICO
 * <script> inline presente no layout (gate RNF-30) — por isso o <html> usa
 * `suppressHydrationWarning` em layout.tsx.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme={DEFAULT_THEME}
      themes={[...LIONCLAW_THEMES]}
      enableSystem={false}
      disableTransitionOnChange={false}
      storageKey="lionclaw-theme"
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}

/**
 * `ThemeRoot` e um marker usado apenas para testes/diagnostico.
 * Nao renderiza nada.
 */
export function ThemeRoot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
