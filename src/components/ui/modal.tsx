"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Modal / Dialog composto do design system (D-FE-04).
 *
 * Espelha o `.modal-overlay` / `.modal` do artifact: scrim com blur, card
 * elevado (surface + border-strong + shadow-overlay), cabecalho/rodape
 * sticky. Fecha por Escape, clique no scrim e botao X. Prende o foco
 * (focus trap) enquanto aberto e devolve o foco ao elemento de origem ao
 * fechar. Trava o scroll do body. Sem hex hardcoded.
 *
 * Acessibilidade: `role="dialog"` + `aria-modal`, `aria-labelledby` /
 * `aria-describedby` derivados de title/description quando presentes.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Titulo no cabecalho (vira aria-labelledby). */
  title?: React.ReactNode;
  /** Descricao curta abaixo do titulo (vira aria-describedby). */
  description?: React.ReactNode;
  /** Conteudo do corpo. */
  children?: React.ReactNode;
  /** Acoes do rodape (ex.: <Button />). Omitido se ausente. */
  footer?: React.ReactNode;
  /** Largura maxima do card. Padrao: 540px. */
  width?: number;
  /** Fecha ao clicar no scrim. Padrao: true. */
  closeOnScrim?: boolean;
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 540,
  closeOnScrim = true,
  className,
}: ModalProps) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const previouslyFocused = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const descId = React.useId();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  // Guarda o foco de origem, foca o dialog e trava o scroll do body.
  React.useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const id = window.requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(
        FOCUSABLE_SELECTOR,
      );
      (first ?? dialogRef.current)?.focus();
    });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.cancelAnimationFrame(id);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    // Focus trap: cicla o foco dentro do dialog.
    const focusables = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-40 grid place-items-center p-6",
        "bg-[color-mix(in_oklch,var(--bg)_64%,transparent)] backdrop-blur-[3px]",
        "duration-150 animate-in fade-in-0",
      )}
      onMouseDown={(event) => {
        if (closeOnScrim && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ width: `min(${width}px, 100%)` }}
        className={cn(
          "max-h-[86vh] overflow-auto rounded-lg border border-border-strong bg-surface",
          "shadow-[var(--shadow-overlay)] outline-none",
          "duration-200 animate-in fade-in-0 zoom-in-95",
          className,
        )}
      >
        {title || description ? (
          <div className="sticky top-0 z-[1] flex items-start justify-between gap-4 border-b border-border bg-surface px-[18px] py-4">
            <div className="min-w-0">
              {title ? (
                <h2
                  id={titleId}
                  className="text-[15px] font-bold tracking-[-0.01em] text-fg"
                >
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p id={descId} className="mt-[3px] text-[13px] text-muted">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Fechar"
              onClick={onClose}
              className={cn(
                "grid size-8 flex-none place-items-center rounded-sm border border-border text-muted",
                "transition-colors hover:border-border-strong hover:text-fg",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line",
              )}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div className="grid gap-[14px] p-[18px]">{children}</div>

        {footer ? (
          <div className="sticky bottom-0 z-[1] flex justify-end gap-2.5 border-t border-border bg-surface px-[18px] py-[14px]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export { Modal as Dialog };
