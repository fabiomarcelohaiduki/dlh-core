"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * ThemeToggle
 *
 * Botao compacto (32x32) instalado no topbar do cockpit. Cicla entre dark e
 * light de forma FIXA (sai do system) e expoe o estado efetivo para leitores
 * de tela via aria-pressed.
 *
 * Decisao de icone usa `resolvedTheme` (tema efetivo, NAO o estado armazenado):
 * isso garante semantica correta quando `localStorage.theme === "system"` e o
 * SO esta em modo claro/escuro — o botao mostra o que esta ATIVO e o
 * aria-label indica o PROXIMO estado (a acao de clicar).
 *
 * Estado loading (resolvedTheme === undefined na primeira renderizacao antes
 * do next-themes hidratar do localStorage) renderiza o botao no tamanho
 * final com `visibility:hidden` no icone para evitar layout shift (zero CLS).
 *
 * Anuncio para leitores de tela: dispara `setTimeout(250ms)` e escreve na
 * regiao `aria-live="polite"` compartilhada (`#theme-announcer`) montada em
 * src/app/layout.tsx. O delay garante que a troca visual ja foi aplicada
 * quando o leitor anuncia (com transicao CSS de 200ms).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  // Hidratado: SABEMOS que next-themes ja leu o localStorage.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const effective = mounted ? resolvedTheme : undefined;
  const isDark = effective === "dark";

  function announce(texto: string) {
    if (typeof window === "undefined") return;
    // Delay: cobre a transicao CSS de 200ms para que o leitor de tela
    // descreva o estado JA aplicado.
    window.setTimeout(() => {
      const el = document.getElementById("theme-announcer");
      if (el) el.textContent = texto;
    }, 250);
  }

  function onClick() {
    // Ciclo FIXO dark <-> light (sai do system) — gate explicito da feature.
    const proximo = isDark ? "light" : "dark";
    setTheme(proximo);
    announce(proximo === "dark" ? "Tema escuro ativado" : "Tema claro ativado");
  }

  // Loading: botao no tamanho final sem icone (zero CLS durante a hidratacao).
  if (!mounted || effective === undefined) {
    return (
      <button
        type="button"
        aria-label="Alternar tema"
        aria-pressed={false}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-sm border border-border bg-surface-2 text-fg transition-colors",
          className,
        )}
      >
        <span aria-hidden="true" className="invisible inline-flex">
          <Sun size={16} />
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isDark ? "Mudar para tema claro" : "Mudar para tema escuro"}
      aria-pressed={isDark}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-sm border border-border bg-surface-2 text-fg transition-colors hover:bg-surface-3 hover:border-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
        className,
      )}
    >
      {isDark ? (
        <Sun aria-hidden="true" size={16} />
      ) : (
        <Moon aria-hidden="true" size={16} />
      )}
    </button>
  );
}