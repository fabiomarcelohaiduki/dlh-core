"use client";

import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * List composta do design system (D-FE-04).
 *
 * Lista de linhas com acoes rapidas inline + um menu "..." contextual.
 * O menu abre/fecha por clique e teclado (Enter/Espaco/Escape), fecha ao
 * clicar fora e devolve o foco ao gatilho. Estilizacao 100% via tokens
 * semanticos (surface/border/fg/muted/accent), sem hex hardcoded.
 *
 * Acessibilidade: o gatilho usa `aria-haspopup="menu"` + `aria-expanded`;
 * o menu usa `role="menu"` e os itens `role="menuitem"`, navegaveis por
 * setas. Linhas usam `role="listitem"` dentro de um `role="list"`.
 */

export interface ListMenuItem {
  /** Identificador unico do item. */
  key: string;
  /** Rotulo exibido. */
  label: string;
  /** Acao ao selecionar. */
  onSelect: () => void;
  /** Icone opcional a esquerda. */
  icon?: React.ReactNode;
  /** Variante destrutiva (texto em token de erro). */
  destructive?: boolean;
  /** Desabilita o item. */
  disabled?: boolean;
}

const List = React.forwardRef<
  HTMLUListElement,
  React.HTMLAttributes<HTMLUListElement>
>(({ className, ...props }, ref) => (
  <ul
    ref={ref}
    role="list"
    className={cn(
      "divide-y divide-border rounded-md border border-border bg-surface",
      className,
    )}
    {...props}
  />
));
List.displayName = "List";

export interface ListItemProps
  extends Omit<React.LiHTMLAttributes<HTMLLIElement>, "title"> {
  /** Conteudo principal da linha (titulo + subtitulo, livre). */
  children: React.ReactNode;
  /** Acoes rapidas exibidas a direita (ex.: <Button size="sm" />). */
  actions?: React.ReactNode;
  /** Itens do menu "..." contextual. Quando vazio, o menu nao e renderizado. */
  menuItems?: ListMenuItem[];
  /** Rotulo acessivel do gatilho do menu. */
  menuLabel?: string;
}

const ListItem = React.forwardRef<HTMLLIElement, ListItemProps>(
  (
    { className, children, actions, menuItems, menuLabel = "Mais acoes", ...props },
    ref,
  ) => (
    <li
      ref={ref}
      role="listitem"
      className={cn(
        "flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? (
        <div className="flex flex-none items-center gap-2">{actions}</div>
      ) : null}
      {menuItems && menuItems.length > 0 ? (
        <ContextMenu items={menuItems} label={menuLabel} />
      ) : null}
    </li>
  ),
);
ListItem.displayName = "ListItem";

/**
 * Menu "..." contextual reutilizavel. Isolado como folha client para conter
 * o estado de abertura sem re-renderizar a lista inteira.
 */
function ContextMenu({
  items,
  label,
}: {
  items: ListMenuItem[];
  label: string;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const close = React.useCallback((focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // Fecha ao clicar fora.
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Foca o primeiro item ao abrir.
  React.useEffect(() => {
    if (open) {
      const id = window.requestAnimationFrame(() => itemRefs.current[0]?.focus());
      return () => window.cancelAnimationFrame(id);
    }
  }, [open]);

  function focusItem(index: number) {
    const total = items.length;
    const next = (index + total) % total;
    itemRefs.current[next]?.focus();
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const current = itemRefs.current.findIndex(
      (el) => el === document.activeElement,
    );
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(current + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(current - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(items.length - 1);
    } else if (event.key === "Tab") {
      close();
    }
  }

  return (
    <div ref={rootRef} className="relative flex-none">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "grid size-8 place-items-center rounded-sm border border-transparent text-muted",
          "transition-colors hover:border-border hover:bg-surface-2 hover:text-fg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
          open && "border-border bg-surface-2 text-fg",
        )}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={cn(
            "absolute right-0 top-[calc(100%+6px)] z-30 w-52 overflow-hidden",
            "rounded-md border border-border-strong bg-surface p-1.5",
            "shadow-[var(--shadow-overlay)]",
            "duration-150 animate-in fade-in-0 zoom-in-95",
          )}
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                close(true);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-[13px]",
                "transition-colors focus-visible:outline-none",
                "hover:bg-accent-soft focus-visible:bg-accent-soft",
                "disabled:pointer-events-none disabled:opacity-50",
                item.destructive ? "text-err" : "text-fg",
              )}
            >
              {item.icon ? (
                <span className="flex size-4 flex-none items-center justify-center [&_svg]:size-4">
                  {item.icon}
                </span>
              ) : null}
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export { List, ListItem };
