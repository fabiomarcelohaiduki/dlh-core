"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Opcoes do SegmentedControl.
 * - "dark"   -> forca tema escuro
 * - "light"  -> forca tema claro
 * - "system" -> segue a preferencia do SO (resolvedTheme = claro/escuro)
 */
type Opcao = "dark" | "light" | "system";

const OPCOES: ReadonlyArray<{
  valor: Opcao;
  label: string;
  Icone: typeof Moon;
}> = [
  { valor: "dark", label: "Escuro", Icone: Moon },
  { valor: "light", label: "Claro", Icone: Sun },
  { valor: "system", label: "Sistema", Icone: Monitor },
];

/**
 * ThemeSegmented
 *
 * SegmentedControl com 3 opcoes (Escuro / Claro / Sistema) usado no card
 * "Aparencia" da pagina Configuracoes da Empresa. Acessibilidade ARIA
 * radiogroup: container com role="radiogroup" + aria-label, cada opcao e
 * role="radio" + aria-checked. Navegacao por setas implementada para
 * paridade com radiogroup nativa.
 *
 * Consome `theme` (estado armazenado) — NAO resolvedTheme — para que o
 * destaque (bg-accent) reflita a escolha do usuario mesmo quando ela for
 * "system" (caso em que resolvedTheme varia com o SO).
 *
 * Usa o Button shadcn refatorado (tokens semanticos) no variant "ghost"
 * com role="radio" e aria-checked por opcao.
 */
export function ThemeSegmented({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Estado armazenado; antes da hidratacao usamos "dark" como padrao estavel
  // (bate com defaultTheme do ThemeProvider).
  const atual: Opcao = mounted && (theme === "dark" || theme === "light" || theme === "system")
    ? (theme as Opcao)
    : "dark";

  function anunciar(opcao: Opcao) {
    if (typeof window === "undefined") return;
    const texto =
      opcao === "dark"
        ? "Tema escuro selecionado"
        : opcao === "light"
          ? "Tema claro selecionado"
          : "Seguindo a preferencia do sistema";
    window.setTimeout(() => {
      const el = document.getElementById("theme-announcer");
      if (el) el.textContent = texto;
    }, 250);
  }

  function onSelect(opcao: Opcao) {
    setTheme(opcao);
    anunciar(opcao);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const idx = OPCOES.findIndex((o) => o.valor === atual);
    if (idx < 0) return;
    let proximo: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      proximo = (idx + 1) % OPCOES.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      proximo = (idx - 1 + OPCOES.length) % OPCOES.length;
    } else if (e.key === "Home") {
      proximo = 0;
    } else if (e.key === "End") {
      proximo = OPCOES.length - 1;
    }
    if (proximo !== null) {
      e.preventDefault();
      const opcao = OPCOES[proximo].valor;
      setTheme(opcao);
      anunciar(opcao);
      // Foco segue a selecao para fechar o loop teclado-leitor.
      const alvo = e.currentTarget.querySelector<HTMLButtonElement>(
        `[data-opcao="${opcao}"]`,
      );
      alvo?.focus();
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Tema da interface"
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 p-1",
        className,
      )}
    >
      {OPCOES.map(({ valor, label, Icone }) => {
        const selecionada = atual === valor;
        return (
          <Button
            key={valor}
            type="button"
            role="radio"
            data-opcao={valor}
            aria-checked={selecionada}
            tabIndex={selecionada ? 0 : -1}
            onClick={() => onSelect(valor)}
            variant="ghost"
            className={cn(
              "h-8 rounded-sm px-3 text-[13px] font-medium gap-2",
              selecionada
                ? "bg-accent text-accent-fg hover:bg-accent hover:border-transparent shadow-[var(--hairline-control)]"
                : "border border-transparent text-fg hover:bg-surface-3 hover:border-border",
            )}
          >
            <Icone aria-hidden="true" size={14} />
            {label}
          </Button>
        );
      })}
    </div>
  );
}